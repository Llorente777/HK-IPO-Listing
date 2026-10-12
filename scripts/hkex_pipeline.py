#!/usr/bin/env python3
"""Build the HK IPO weekly database from official HKEX/HKEXnews sources.

The user-provided workbook is accepted only as an optional, one-time seed for
historic A/H code mappings.  Every production observation is re-validated
against an official exchange source and future runs do not require the file.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import csv
import difflib
import hashlib
import html
import io
import json
import os
import re
import shutil
import statistics
import subprocess
import sys
import threading
import time
import unicodedata
import urllib.parse
import urllib.request
import zipfile
from collections import Counter, defaultdict
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from xml.etree import ElementTree as ET


ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
RAW = DATA / "raw" / "official"
PROCESSED = DATA / "processed"
REFERENCE = DATA / "reference"
SNAPSHOTS = DATA / "snapshots"
PUBLIC_DATA = ROOT / "public" / "data"

HK_TZ = timezone(timedelta(hours=8))
UA = os.environ.get(
    "HKIPO_USER_AGENT",
    "HKIPO-Research-Monitor/1.0 (public research; weekly; low-frequency)",
)
RATE_SECONDS = float(os.environ.get("HKIPO_RATE_SECONDS", "0.35"))

HKEX_NLR_PAGE = (
    "https://www2.hkexnews.hk/New-Listings/New-Listing-Information/"
    "Main-Board?sc_lang=zh-HK"
)
HKEX_NEWLY_LISTED_SECURITIES = (
    "https://www.hkex.com.hk/Services/Trading/Securities/Trading-News/"
    "Newly-Listed-Securities?sc_lang=en"
)
HKEX_NLR_TEMPLATE = (
    "https://www2.hkexnews.hk/-/media/HKEXnews/Homepage/New-Listings/"
    "New-Listing-Information/New-Listing-Report/Main/NLR{year}_Chi.xlsx"
)
HKEX_GEM_BASE = (
    "https://www2.hkexnews.hk/-/media/HKEXnews/Homepage/New-Listings/"
    "New-Listing-Information/New-Listing-Report/GEM/{filename}"
)
HKEX_APP_JSON = "https://www1.hkexnews.hk/ncms/json/eds/{name}.json"
HKEX_APP_DOC = "https://www1.hkexnews.hk/app/{path}"
HKEX_ACTIVE_STOCKS = "https://www1.hkexnews.hk/ncms/script/eds/activestock_sehk_c.json"
HKEX_INACTIVE_STOCKS = "https://www1.hkexnews.hk/ncms/script/eds/inactivestock_sehk_c.json"
HKEX_TITLE_SEARCH = "https://www1.hkexnews.hk/search/titlesearch.xhtml"
HKEX_MARKET_COMMUNICATIONS_PAGE = (
    "https://www.hkex.com.hk/News/Market-Communications?"
    "Category=Market+Operations&sc_lang=en&view=CardView"
)
SSE_QUERY = "https://query.sse.com.cn/sseQuery/commonQuery.do"
SSE_REFERER = "https://www.sse.com.cn/assortment/stock/list/share/"
SZSE_LIST = "https://www.szse.cn/api/report/ShowReport"
SZSE_REFERER = "https://www.szse.cn/market/product/stock/list/index.html"
SZSE_MARKET_REFERER = "https://www.szse.cn/market/trend/index.html"
SZSE_COMPANY_NOTICES = "https://www.szse.cn/www/disclosure/notice/company/"
CSRC_FILING_PAGE = "https://www.csrc.gov.cn/csrc/c106251/common_list.shtml"

# This is deliberately transparent and editable in the output.  It mirrors the
# user's workbook convention, but is a model estimate rather than an exchange
# forecast: implied H valuation = A market cap × (1 - discount), issue size =
# implied H valuation × issue ratio, with a 15% green-shoe sensitivity.
MODEL_HA_DISCOUNT_PCT = 35.7
MODEL_ISSUE_RATIO_PCT = 10.0
MODEL_GREENSHOE_PCT = 15.0

# HKEX's annual Main Board report includes GEM-to-Main transfers alongside
# IPOs.  They are valid listing events, but must not enter IPO counts, proceeds
# or sponsor league tables.  The codes below are confirmed historic transfers;
# the structural rule below also catches future transfers automatically.
KNOWN_GEM_TO_MAIN_CODES = {
    "00933",  # 非凡中国控股 (former GEM 08032)
    "02176",  # 赛迪顾问 (former GEM 08235)
    "02295",  # 丰城控股
    "03774",  # 亮晴控股 (former GEM 08603)
    "06051",  # 有赞科技 (former GEM 08083)
    "06663",  # 国际永胜集团
    "09689",  # 金泰丰国际控股 (former GEM 08479)
    "09882",  # 永联丰集团控股 (former GEM 08617)
    "09876",  # 大洋环球控股 (former GEM 08476)
    "09893",  # 比优集团控股 (former GEM 08053)
}

# A zero-fundraising row in the annual new-listing report is a listing event,
# but it is not automatically an IPO. These registries make the historic
# treatment explicit; document-title and structural rules below keep future
# weekly updates on the same basis.
KNOWN_DESPAC_SUCCESSOR_CODES = {"02562", "02665", "06676"}

KNOWN_PROSPECTUS_DATE_CORRECTIONS = {
    (2023, "02469"): "2022-12-23",  # Fenbi prospectus, not listing date
    (2021, "09600"): "2020-12-21",  # Newlink prospectus
    (2021, "01855"): "2020-12-22",  # Zonbong prospectus
}

# The annual NLR is not a live listing feed. These rows are transcribed from
# issuer-level HKEXnews final allotment notices only after the trading list
# independently confirms actual (not tentative) admission. A new unmatched
# equity listing stops publication until its final terms have been verified.
VERIFIED_NLR_GAP_FILLS: dict[str, dict[str, Any]] = {
    "09856": {
        "year": 2026,
        "company_name": "纳真科技公司",
        "prospectus_date": "2026-09-14",
        "listing_date": "2026-09-22",
        "sponsors": ["花旗环球金融亚洲有限公司", "中信证券（香港）有限公司"],
        "reporting_accountant": "安永会计师事务所",
        "property_valuer": None,
        "public_offer_shares": 17_201_500,
        "international_placing_shares": 154_813_200,
        "offer_price_hkd": 32.96,
        "is_h_share_name": False,
        "source_url": "https://www1.hkexnews.hk/listedco/listconews/sehk/2026/0921/2026092101568_c.pdf",
        "verification_note": "2026-09-28核读配发结果第2–5页、招股书第67–69页。保荐人为中信证券（香港），不是同页整体协调人中信里昂。基础发行规模不把超额分配当作已行使绿鞋；开曼注册非H股。",
    },
    "06727": {
        "year": 2026,
        "company_name": "星环信息科技（上海）股份有限公司 - H股",
        "prospectus_date": "2026-09-11",
        "listing_date": "2026-09-21",
        "sponsors": ["海通国际资本有限公司"],
        "reporting_accountant": "德勤·关黄陈方会计师行",
        "property_valuer": None,
        "public_offer_shares": 2_802_200,
        "international_placing_shares": 11_208_600,
        "offer_price_hkd": 49.0,
        "is_h_share_name": True,
        "source_url": "https://www1.hkexnews.hk/listedco/listconews/sehk/2026/0918/2026091801414.pdf",
    },
}

# Official HKEXnews final listing files that the historical title-search API
# does not reliably return (date drift, reused stock codes or old multi-file
# pages). These are immutable first-party links, not third-party fallbacks.
KNOWN_FINAL_LISTING_DOCUMENTS: dict[tuple[int, str], dict[str, Any]] = {
    (2023, "02469"): {"date": "2022-12-23", "url": "https://www1.hkexnews.hk/listedco/listconews/sehk/2022/1223/2022122300006_c.pdf", "title": "招股章程"},
    (2022, "03611"): {"date": "2022-11-30", "url": "https://www1.hkexnews.hk/listedco/listconews/sehk/2022/1130/2022113000012_c.pdf", "title": "招股章程"},
    (2022, "06689"): {"date": "2022-08-24", "url": "https://www1.hkexnews.hk/listedco/listconews/sehk/2022/0824/2022082400046_c.pdf", "title": "招股章程"},
    (2021, "09956"): {"date": "2021-10-29", "url": "https://www1.hkexnews.hk/listedco/listconews/sehk/2021/1029/2021102902075_c.pdf", "title": "招股章程"},
    (2021, "02217"): {"date": "2021-09-23", "url": "https://www1.hkexnews.hk/listedco/listconews/sehk/2021/0923/2021092300032_c.pdf", "title": "招股章程"},
    (2021, "02207"): {"date": "2021-06-30", "url": "https://www1.hkexnews.hk/listedco/listconews/sehk/2021/0630/2021063000094_c.pdf", "title": "招股章程"},
    (2021, "06600"): {"date": "2021-02-19", "url": "https://www1.hkexnews.hk/listedco/listconews/sehk/2021/0219/2021021900088_c.pdf", "title": "招股章程"},
    (2021, "06606"): {"date": "2021-02-05", "url": "https://www1.hkexnews.hk/listedco/listconews/sehk/2021/0205/2021020500018_c.pdf", "title": "招股章程"},
    (2021, "09600"): {"date": "2020-12-21", "url": "https://www1.hkexnews.hk/listedco/listconews/sehk/2020/1221/2020122100006_c.pdf", "title": "招股章程"},
    (2021, "01855"): {"date": "2020-12-22", "url": "https://www1.hkexnews.hk/listedco/listconews/sehk/2020/1222/2020122200050.htm", "title": "招股章程（多文件版）"},
    (2022, "06638"): {"date": "2022-06-28", "url": "https://www1.hkexnews.hk/listedco/listconews/sehk/2022/0628/2022062800235_c.pdf", "title": "以介绍方式在主板上市"},
    (2023, "09882"): {"date": "2023-09-22", "url": "https://www1.hkexnews.hk/listedco/listconews/sehk/2023/0922/2023092201797_c.pdf", "title": "由GEM转往主板上市"},
    (2023, "00933"): {"date": "2023-06-20", "url": "https://www1.hkexnews.hk/listedco/listconews/sehk/2023/0620/2023062000029_c.pdf", "title": "由GEM转往主板上市"},
    (2023, "09689"): {"date": "2023-05-11", "url": "https://www1.hkexnews.hk/listedco/listconews/sehk/2023/0511/2023051100304_c.pdf", "title": "由GEM转往主板上市"},
}

KNOWN_SPAC_IPO_CODES = {"07855", "07801", "07841", "07827", "07836"}

# A failed public search is not evidence that a document is unavailable.
# These gaps remain pending and are retried by normal weekly collection.
SPAC_DOCUMENT_PENDING_REASON = "尚未核实公司级最终发售文件直链；SPAC为专业投资者发售，但不能据此断言文件不公开。"

OFFICIAL_NAME_ALIASES = {
    "600801": {
        "names": ["华新水泥股份有限公司", "华新建材集团股份有限公司"],
        "source_url": "https://www.sse.com.cn/disclosure/listedinfo/announcement/c/new/2025-11-01/600801_20251101_04WE.pdf",
    },
}

XLSX_NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
REL_NS = "{http://schemas.openxmlformats.org/package/2006/relationships}"
DOC_REL_NS = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"

STATUS_LABELS = {
    "A": "有效申请",
    "LP": "失效",
    "LT": "已上市",
    "W": "撤回",
    "RJ": "被拒",
    "RT": "退回",
}


class Fetcher:
    def __init__(self) -> None:
        self.last_request = 0.0
        self.manifest: list[dict[str, Any]] = []
        self.rate_lock = threading.Lock()

    def get(self, url: str, *, referer: str | None = None, retries: int = 3) -> bytes:
        for attempt in range(retries):
            with self.rate_lock:
                delay = RATE_SECONDS - (time.monotonic() - self.last_request)
                if delay > 0:
                    time.sleep(delay)
                self.last_request = time.monotonic()
            headers = {"User-Agent": UA, "Accept": "*/*"}
            if referer:
                headers["Referer"] = referer
            request = urllib.request.Request(url, headers=headers)
            try:
                with urllib.request.urlopen(request, timeout=75) as response:
                    payload = response.read()
                    return payload
            except Exception:
                if attempt + 1 == retries:
                    raise
                time.sleep(1.2 * (attempt + 1))
        raise RuntimeError("unreachable")

    def save(
        self,
        url: str,
        relative_path: str,
        *,
        referer: str | None = None,
        source: str,
        immutable: bool = False,
    ) -> bytes:
        destination = RAW / relative_path
        destination.parent.mkdir(parents=True, exist_ok=True)
        force_refresh = os.environ.get("HKIPO_FORCE_REFRESH") == "1"
        if destination.exists() and (immutable or not force_refresh):
            payload = destination.read_bytes()
            cache_status = "reused"
            fetched_at = datetime.fromtimestamp(destination.stat().st_mtime, HK_TZ).isoformat(timespec="seconds")
        else:
            payload = self.get(url, referer=referer)
            destination.write_bytes(payload)
            cache_status = "downloaded"
            fetched_at = datetime.now(HK_TZ).isoformat(timespec="seconds")
        self.manifest.append(
            {
                "source": source,
                "url": url,
                "local_file": destination.relative_to(ROOT).as_posix(),
                "bytes": len(payload),
                "sha256": hashlib.sha256(payload).hexdigest(),
                "fetched_at": fetched_at,
                "cache_status": cache_status,
            }
        )
        return payload


def clean_text(value: Any) -> str:
    if value is None:
        return ""
    return re.sub(r"\s+", " ", html.unescape(str(value))).strip()


SPONSOR_ALIASES = {
    "）同人融资有限公司": "同人融资有限公司",
    "法律顾问华泰金融控股（香港）有限公司": "华泰金融控股（香港）有限公司",
    "国际金融中心一期3001-3006及3015-3016中信证券（香港）有限公司": "中信证券（香港）有限公司",
    "整体高盛（亚洲）有限责任公司": "高盛（亚洲）有限责任公司",
    "整中信建投（国际）融资有限公司": "中信建投（国际）融资有限公司",
    "招商证劵（香港）有限公司": "招商证券（香港）有限公司",
    "德意志证券亚洲有限公": "德意志证券亚洲有限公司",
    "泰金融控股（香港）有限公司": "华泰金融控股（香港）有限公司",
    "皇农银国际融资有限公司": "农银国际融资有限公司",
    "J.P. Morgan Securities (Far East) Ltd.": "J.P. Morgan Securities (Far East) Limited",
    "摩根大通证券（远东）有限公司": "J.P. Morgan Securities (Far East) Limited",
    "UBS Securities Hong Kong Ltd.": "UBS Securities Hong Kong Limited",
    "Citigroup Global Markets Asia Limited": "花旗环球金融亚洲有限公司",
}

NON_SPONSOR_ENTITIES = {
    # This legal entity appears in AP party tables as an overall coordinator,
    # while the appointed sponsor is J.P. Morgan Securities (Far East) Limited.
    "J.P. Morgan Securities (Asia Pacific) Limited",
}

SPONSOR_EMBEDDED_ALIASES = (
    ("J.P. Morgan Securities (Asia Pacific) Limited", ""),
    ("J.P. Morgan Securities (Far East) Limited", "J.P. Morgan Securities (Far East) Limited"),
    ("J.P. Morgan Securities (Far East) Ltd.", "J.P. Morgan Securities (Far East) Limited"),
    ("HSBC Corporate Finance (Hong Kong) Limited", "HSBC Corporate Finance (Hong Kong) Limited"),
    ("Merrill Lynch (Asia Pacific) Limited", "Merrill Lynch (Asia Pacific) Limited"),
    ("UBS Securities Hong Kong Limited", "UBS Securities Hong Kong Limited"),
    ("UBS Securities Hong Kong Ltd.", "UBS Securities Hong Kong Limited"),
    ("Citigroup Global Markets Asia Limited", "花旗环球金融亚洲有限公司"),
)

SPONSOR_ROLE_PREFIXES = (
    r"^(?:独家|联席)?整体协调人及(?:独家|联席)?保荐人兼",
    r"^(?:独家|联席)?保荐人兼整体协调人及?",
    r"^(?:独家|联席)?保荐人兼整体协调人",
    r"^(?:独家|联席)?保荐人兼整体",
    r"^(?:独家|联席)?保荐人兼",
    r"^(?:独家|联席)?保荐人及",
    r"^(?:独家|联席)?保荐人",
    r"^(?:独家|联席)?上市代理人",
)


def canonical_sponsor_name(value: str) -> str:
    """Return one display name for punctuation, spacing and role variants."""
    name = unicodedata.normalize("NFKC", clean_text(value))
    name = re.sub(r"^\((?:排序不分先后|按字母顺序(?:排列)?)\)\s*", "", name)
    name = name.strip("、;；,，•·-–— ")
    if name.startswith("(") and name.count("(") > name.count(")"):
        name = name[1:].strip()

    role_match = re.search(
        r"(?:独家|联席)?(?:整体协调人及)?保荐人(?:兼整体协调人|兼整体|兼|及)?",
        name,
    )
    if role_match and role_match.start() > 0:
        name = name[role_match.start():]

    address_end = max((name.rfind(marker) for marker in ("楼", "层", "室", "号")), default=-1)
    if address_end >= 0:
        tail = name[address_end + 1:].strip()
        if len(tail) >= 4 and re.search(r"(?:有限责任公司|股份有限公司|有限公司|Limited|Ltd\.?)$", tail, re.I):
            name = tail

    # A pure coordinator/bookrunner line is outside the sponsor field. Lines
    # that explicitly contain 保荐人 are retained after removing the role.
    if re.match(r"^(?:独家|联席)?整体协调人", name) and "保荐人" not in name:
        return ""
    if re.match(r"^(?:\[?编纂\]?|编)(?!制)", name):
        return ""
    for pattern in SPONSOR_ROLE_PREFIXES:
        updated = re.sub(pattern, "", name)
        if updated != name:
            name = updated.lstrip("及、,， ")
            break

    embedded_key = re.sub(r"[^\w\u4e00-\u9fff]", "", unicodedata.normalize("NFKC", name)).lower()
    for alias, canonical in SPONSOR_EMBEDDED_ALIASES:
        alias_key = re.sub(r"[^\w\u4e00-\u9fff]", "", unicodedata.normalize("NFKC", alias)).lower()
        if alias_key in embedded_key:
            return canonical

    if re.search(r"[\u4e00-\u9fff]", name):
        name = re.sub(r"\s+", "", name)
        name = name.replace("(", "（").replace(")", "）")
    else:
        name = clean_text(name)
        name = re.sub(r"\s+([),.])", r"\1", name)
        name = re.sub(r"([(])\s+", r"\1", name)

    name = SPONSOR_ALIASES.get(name, name)
    if name in NON_SPONSOR_ENTITIES:
        return ""
    return name


def normalize_sponsor_names(values: list[str]) -> list[str]:
    """Canonicalize, split merged legal entities and de-duplicate sponsors."""
    output: list[str] = []
    entity_pattern = re.compile(
        r".+?(?:有限责任公司|股份有限公司|有限公司|Limited|Ltd\.?)",
        re.I,
    )
    for value in values:
        name = canonical_sponsor_name(value)
        if not name:
            continue
        entities = [clean_text(match.group(0)) for match in entity_pattern.finditer(name)]
        remainder = entity_pattern.sub("", name).strip("、;；,，/／ ")
        candidates = entities if len(entities) > 1 and not remainder else [name]
        for candidate in candidates:
            canonical = canonical_sponsor_name(candidate)
            if canonical and canonical not in output:
                output.append(canonical)
    return output


def simplify_texts(values: list[str], *, preserve_whitespace: bool = False) -> list[str]:
    """Convert HK Traditional Chinese to Simplified Chinese with vendored OpenCC.

    HKEX's Chinese feeds are Traditional Chinese while SSE/SZSE names are
    Simplified Chinese.  Converting before matching prevents the severe
    undercount previously seen in the A-to-H active pipeline.
    """
    if not values:
        return []
    node_binary = os.environ.get("NODE_BINARY") or shutil.which("node")
    converter = ROOT / "scripts" / "convert-chinese.mjs"
    if not node_binary or not converter.exists():
        return values
    result = subprocess.run(
        [node_binary, str(converter)],
        input=json.dumps(values, ensure_ascii=False),
        text=True,
        encoding="utf-8",
        capture_output=True,
        check=False,
        timeout=120,
    )
    if result.returncode != 0:
        print(f"OpenCC conversion unavailable: {result.stderr.strip()}", file=sys.stderr)
        return values
    converted = json.loads(result.stdout)
    return [str(value) if preserve_whitespace else clean_text(value) for value in converted]


def simplify_records(records: list[dict[str, Any]], fields: tuple[str, ...]) -> None:
    positions: list[tuple[dict[str, Any], str]] = []
    values: list[str] = []
    for record in records:
        for field in fields:
            value = record.get(field)
            if isinstance(value, str) and value:
                positions.append((record, field))
                values.append(value)
    for (record, field), simplified in zip(positions, simplify_texts(values)):
        traditional_key = f"{field}_traditional"
        if simplified != record[field]:
            record[traditional_key] = record[field]
        record[field] = simplified


def simplify_list_field(records: list[dict[str, Any]], field: str) -> None:
    positions: list[tuple[dict[str, Any], int]] = []
    values: list[str] = []
    for record in records:
        items = record.get(field)
        if not isinstance(items, list):
            continue
        for index, value in enumerate(items):
            if isinstance(value, str) and value:
                positions.append((record, index))
                values.append(value)
    converted = simplify_texts(values)
    for (record, index), value in zip(positions, converted):
        record[field][index] = value
    for record in records:
        if isinstance(record.get(field), list):
            record[field] = (
                normalize_sponsor_names(record[field])
                if field == "sponsors"
                else list(dict.fromkeys(record[field]))
            )


def normalize_company(value: str) -> str:
    value = unicodedata.normalize("NFKC", clean_text(value)).lower()
    value = re.sub(r"\s*\((?:前称为?|前稱為?|曾用名[:：]?|formerly(?: known as)?)\s*[^)]*\)", "", value)
    value = re.sub(r"(?:\s*[-—–－]\s*(?:h\s*股|[bpswz]{1,3}))+\s*$", "", value)
    value = re.sub(r"[-—–－·•（）()\[\]【】,，.。/\\\s]", "", value)
    for suffix in (
        "股份有限公司",
        "集团有限公司",
        "控股有限公司",
        "有限公司",
        "股份",
        "集团",
        "控股",
        "h股",
        "h股公司",
    ):
        value = value.replace(suffix, "")
    return value


def split_sponsors(value: str) -> list[str]:
    parts = re.split(r"\s*/\s*|\s*／\s*|\n+|,(?=[^ ])", value or "")
    repaired: list[str] = []
    for part in (clean_text(item) for item in parts if clean_text(item)):
        if repaired and repaired[-1] == "J.P. Morgan Securities" and re.fullmatch(r"\(Far East\) (?:Limited|Ltd\.?)", part, re.I):
            repaired[-1] = f"{repaired[-1]} {part}"
        else:
            repaired.append(part)
    return repaired


def excel_date(value: str) -> str | None:
    if not value:
        return None
    try:
        number = float(value)
    except ValueError:
        return clean_text(value)
    if number <= 0:
        return None
    return (date(1899, 12, 30) + timedelta(days=int(number))).isoformat()


def parse_day_month_year(value: str | None) -> str | None:
    if not value:
        return None
    try:
        return datetime.strptime(value, "%d/%m/%Y").date().isoformat()
    except ValueError:
        return value


def column_letters(cell_reference: str) -> str:
    match = re.match(r"([A-Z]+)", cell_reference)
    return match.group(1) if match else cell_reference


def _xlsx_shared_strings(book: zipfile.ZipFile) -> list[str]:
    if "xl/sharedStrings.xml" not in book.namelist():
        return []
    root = ET.fromstring(book.read("xl/sharedStrings.xml"))
    return ["".join(node.text or "" for node in item.iter(XLSX_NS + "t")) for item in root.findall(XLSX_NS + "si")]


def xlsx_sheets(
    payload_or_path: bytes | Path,
    selected_names: set[str] | None = None,
) -> dict[str, list[dict[str, str]]]:
    source: io.BytesIO | Path
    source = io.BytesIO(payload_or_path) if isinstance(payload_or_path, bytes) else payload_or_path
    with zipfile.ZipFile(source) as book:
        shared = _xlsx_shared_strings(book)
        workbook = ET.fromstring(book.read("xl/workbook.xml"))
        rels = ET.fromstring(book.read("xl/_rels/workbook.xml.rels"))
        targets = {node.attrib["Id"]: node.attrib["Target"] for node in rels}
        output: dict[str, list[dict[str, str]]] = {}
        sheets_node = workbook.find(XLSX_NS + "sheets")
        for sheet in list(sheets_node) if sheets_node is not None else []:
            if selected_names is not None and sheet.attrib["name"] not in selected_names:
                continue
            target = targets[sheet.attrib[DOC_REL_NS + "id"]].lstrip("/")
            if not target.startswith("xl/"):
                target = "xl/" + target
            if target not in book.namelist():
                continue
            root = ET.fromstring(book.read(target))
            rows: list[dict[str, str]] = []
            for row in root.findall(".//" + XLSX_NS + "row"):
                values: dict[str, str] = {}
                for cell in row.findall(XLSX_NS + "c"):
                    key = column_letters(cell.attrib.get("r", ""))
                    kind = cell.attrib.get("t")
                    raw = cell.find(XLSX_NS + "v")
                    if kind == "inlineStr":
                        value = "".join(node.text or "" for node in cell.iter(XLSX_NS + "t"))
                    elif raw is None:
                        value = ""
                    elif kind == "s":
                        try:
                            value = shared[int(raw.text or "0")]
                        except (IndexError, ValueError):
                            value = ""
                    else:
                        value = raw.text or ""
                    if value != "":
                        values[key] = value
                rows.append(values)
            output[sheet.attrib["name"]] = rows
        return output


def parse_nlr(payload: bytes, year: int, source_url: str) -> tuple[list[dict[str, Any]], str | None]:
    rows = next(iter(xlsx_sheets(payload).values()))
    title_text = " ".join(value for row in rows[:3] for value in row.values())
    as_of_match = re.search(r"截至\s*(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日", title_text)
    as_of = None
    if as_of_match:
        as_of = f"{as_of_match.group(1)}-{int(as_of_match.group(2)):02d}-{int(as_of_match.group(3)):02d}"
    records: list[dict[str, Any]] = []
    for index, row in enumerate(rows):
        if not row.get("A", "").isdigit() or not re.fullmatch(r"\d{4,5}", row.get("B", "")):
            continue
        placing = 0.0
        if index + 1 < len(rows) and rows[index + 1].get("K") == "(b)":
            try:
                placing = float(rows[index + 1].get("I", "0"))
            except ValueError:
                placing = 0.0
        try:
            public_offer = float(row.get("I", "0"))
        except ValueError:
            public_offer = 0.0
        try:
            offer_price = float(row.get("J", "0"))
        except ValueError:
            offer_price = None
        name = clean_text(row.get("C", ""))
        records.append(
            {
                "year": year,
                "sequence": int(row["A"]),
                "hk_code": row["B"].zfill(5),
                "company_name": name,
                "prospectus_date": excel_date(row.get("D", "")),
                "listing_date": excel_date(row.get("E", "")),
                "sponsors": split_sponsors(row.get("F", "")),
                "reporting_accountant": clean_text(row.get("G", "")) or None,
                "property_valuer": clean_text(row.get("H", "")) or None,
                "public_offer_hkd": round(public_offer, 2),
                "international_placing_hkd": round(placing, 2),
                "total_proceeds_hkd": round(public_offer + placing, 2),
                "offer_price_hkd": offer_price,
                "is_h_share_name": bool(re.search(r"H\s*股|Ｈ\s*股", unicodedata.normalize("NFKC", name), re.I)),
                "market": "主板",
                "source_url": source_url,
                "source_as_of": as_of,
                "source_grade": "A",
            }
        )
    return records, as_of


def gem_report_filename(year: int) -> str:
    if year == 2021:
        return "tc_newlistings21.xls"
    if year == 2022:
        return "tc_newlistings.xlsx"
    if year == 2023:
        return "tc_newlistings.xls"
    return f"tc_newlistings{year}.xlsx"


def parse_gem_report(payload: bytes, year: int, source_url: str) -> tuple[list[dict[str, Any]], str | None]:
    rows = next(iter(xlsx_sheets(payload).values()))
    title_text = " ".join(value for row in rows[:8] for value in row.values())
    as_of_match = re.search(r"截至\s*(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日", title_text)
    as_of = None
    if as_of_match:
        as_of = f"{as_of_match.group(1)}-{int(as_of_match.group(2)):02d}-{int(as_of_match.group(3)):02d}"
    records: list[dict[str, Any]] = []
    for row in rows:
        if not row.get("A", "").isdigit() or not re.fullmatch(r"\d{4}", row.get("B", "")):
            continue
        try:
            proceeds = float(row.get("J", "0"))
        except ValueError:
            proceeds = 0.0
        try:
            offer_price = float(row.get("F", "0"))
        except ValueError:
            offer_price = None
        name = clean_text(row.get("C", ""))
        records.append(
            {
                "year": year,
                "sequence": len(records) + 1,
                "hk_code": row["B"].zfill(5),
                "company_name": name,
                "prospectus_date": None,
                "listing_date": excel_date(row.get("A", "")),
                "sponsors": split_sponsors(row.get("T", "")),
                "reporting_accountant": clean_text(row.get("V", "")) or None,
                "property_valuer": None,
                "public_offer_hkd": None,
                "international_placing_hkd": None,
                "total_proceeds_hkd": round(proceeds, 2),
                "offer_price_hkd": offer_price,
                "industry": clean_text(row.get("O", "")) or None,
                "listing_method": clean_text(row.get("R", "")) or None,
                "is_h_share_name": bool(re.search(r"H\s*股|Ｈ\s*股", unicodedata.normalize("NFKC", name), re.I)),
                "market": "GEM",
                "source_url": source_url,
                "source_as_of": as_of,
                "source_grade": "A",
            }
        )
    return records, as_of


def split_ipo_and_non_ipo_listings(
    records: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Separate fundraising IPOs from other official new-listing events.

    HKEX's annual report intentionally covers more than IPOs. Introduction
    listings, GEM-to-Main transfers and De-SPAC successor-company listings have
    no public/placing proceeds and must not inflate IPO counts or sponsor tables.
    """

    ipos: list[dict[str, Any]] = []
    excluded: list[dict[str, Any]] = []
    for record in records:
        code = record.get("hk_code")
        title = clean_text(record.get("original_document_title")).replace(" ", "")
        zero_fundraising = record.get("market") == "主板" and float(record.get("total_proceeds_hkd") or 0) == 0
        if (zero_fundraising and code in KNOWN_GEM_TO_MAIN_CODES) or "GEM转往主板" in title or "GEM轉往主板" in title:
            classification = "GEM转主板"
            reason = "转板属于既有上市地位迁移，不属于首次公开发行；不计入IPO家数、募资额及保荐人排名。"
            rule = "known official transfer code or final HKEXnews listing-document title"
        elif (zero_fundraising and code in KNOWN_DESPAC_SUCCESSOR_CODES) or "特殊目的收购公司并购交易" in title or "特殊目的收購公司併購交易" in title:
            classification = "De-SPAC继承公司"
            reason = "De-SPAC继承公司上市不是该年度的首次公开募股；不计入IPO家数、募资额及保荐人排名。"
            rule = "known official De-SPAC successor code or final HKEXnews transaction-circular title"
        elif "介绍方式" in title or "介紹方式" in title or "介绍形式" in title or "介紹形式" in title:
            classification = "介绍上市"
            reason = "介绍上市不发行新股募资；不计入IPO家数、募资额及保荐人排名。"
            rule = "final HKEXnews listing-document title"
        elif zero_fundraising:
            classification = "非募资新上市"
            reason = "港交所年度报告显示该主板上市事件发售及配售募资额均为零，不计入募资型IPO统计。"
            rule = "HKEX NLR Main Board zero-fundraising signature"
        else:
            classification = None
            reason = None
            rule = None

        if classification:
            excluded_record = dict(record)
            excluded_record.update({
                "ipo_classification": classification,
                "hk_listing_method": classification,
                "excluded_from_ipo_statistics": True,
                "exclusion_reason": reason,
                "classification_rule": rule,
            })
            excluded.append(excluded_record)
        else:
            record["ipo_classification"] = "IPO"
            record["hk_listing_method"] = "IPO"
            record["excluded_from_ipo_statistics"] = False
            ipos.append(record)
    excluded.sort(key=lambda item: item.get("listing_date") or "", reverse=True)
    return ipos, excluded


def absolute_app_url(value: str | None) -> str | None:
    if not value or value == "#":
        return None
    if value.startswith("http"):
        return value
    return HKEX_APP_DOC.format(path=value.lstrip("/"))


def normalize_application(record: dict[str, Any], observed_year: int | None = None, board: str = "主板") -> dict[str, Any]:
    documents: list[dict[str, Any]] = []
    for version_group, items in (("latest", record.get("ls", [])), ("previous", record.get("ps", []))):
        for item in items:
            documents.append(
                {
                    "date": parse_day_month_year(item.get("d")),
                    "document_type": clean_text(item.get("nF")) or "其他文件",
                    "full_document_name": clean_text(item.get("nS1")) or None,
                    "full_document_url": absolute_app_url(item.get("u1")),
                    "multi_file_name": clean_text(item.get("nS2")) or None,
                    "multi_file_url": absolute_app_url(item.get("u2")),
                    "version_group": version_group,
                }
            )
    dates = sorted(item["date"] for item in documents if item.get("date"))
    status_code = str(record.get("s", ""))
    first_date = dates[0] if dates else parse_day_month_year(record.get("d"))
    latest_date = dates[-1] if dates else parse_day_month_year(record.get("d"))
    try:
        age_days = (datetime.now(HK_TZ).date() - date.fromisoformat(first_date)).days if first_date else None
    except ValueError:
        age_days = None
    application_rounds = sum("申請版本" in item["document_type"] or "申请版本" in item["document_type"] for item in documents)
    return {
        "application_id": str(record.get("id", "")),
        "company_name": clean_text(record.get("a")),
        "status_code": status_code,
        "status": STATUS_LABELS.get(status_code, status_code or "未知"),
        "posting_date": parse_day_month_year(record.get("d")),
        "first_document_date": first_date,
        "latest_document_date": latest_date,
        "has_phip": bool(record.get("hasPhip")),
        "hk_code": str(record.get("st", "")).zfill(5) if record.get("st") else None,
        "warning_url": absolute_app_url(record.get("w")),
        "documents": documents,
        "document_count": len(documents),
        "application_rounds": application_rounds,
        "application_age_days": age_days,
        "sponsors": [],
        "sponsor_source_url": None,
        "observed_year": observed_year,
        "market": board,
        "source_grade": "A",
    }


def application_as_of(record: dict[str, Any], cutoff: date) -> dict[str, Any] | None:
    cutoff_text = cutoff.isoformat()
    posting_date = record.get("posting_date")
    if posting_date and posting_date > cutoff_text:
        return None
    original_documents = record.get("documents") or []
    documents = [item for item in original_documents if not item.get("date") or item["date"] <= cutoff_text]
    if not documents and record.get("first_document_date") and record["first_document_date"] > cutoff_text:
        return None
    output = dict(record)
    output["documents"] = documents
    dates = sorted(item["date"] for item in documents if item.get("date"))
    output["first_document_date"] = dates[0] if dates else posting_date
    output["latest_document_date"] = dates[-1] if dates else posting_date
    output["document_count"] = len(documents)
    output["application_rounds"] = sum(
        "申請版本" in item.get("document_type", "") or "申请版本" in item.get("document_type", "")
        for item in documents
    )
    output["application_age_days"] = (
        (cutoff - date.fromisoformat(output["first_document_date"])).days
        if output.get("first_document_date") else None
    )
    if len(documents) != len(original_documents):
        output["has_phip"] = any(
            "PHIP" in ((item.get("document_type") or "") + (item.get("full_document_name") or "")).upper()
            or "聆訊後" in ((item.get("document_type") or "") + (item.get("full_document_name") or ""))
            or "聆讯后" in ((item.get("document_type") or "") + (item.get("full_document_name") or ""))
            for item in documents
        )
    return output


def _html_anchors(payload: bytes, base_url: str) -> list[tuple[str, str]]:
    text = payload.decode("utf-8", "replace")
    output: list[tuple[str, str]] = []
    for match in re.finditer(
        r"<a\b[^>]*?href\s*=\s*[\"']([^\"']+)[\"'][^>]*>(.*?)</a>",
        text,
        re.I | re.S,
    ):
        label = clean_text(re.sub(r"<[^>]+>", " ", match.group(2)))
        output.append((urllib.parse.urljoin(base_url, html.unescape(match.group(1))), label))
    return output


def _visible_html_text(payload: bytes) -> str:
    text = payload.decode("utf-8", "replace")
    text = re.sub(r"<(?:script|style)\b[^>]*>.*?</(?:script|style)>", " ", text, flags=re.I | re.S)
    text = re.sub(r"<[^>]+>", " ", text)
    return clean_text(text)


def parse_newly_listed_securities(payload: bytes) -> tuple[list[dict[str, Any]], str]:
    """Read actual equity admissions, keeping tentative dates out of IPO counts."""
    text = payload.decode("utf-8", "replace")
    visible = _visible_html_text(payload)
    update_match = re.search(r"Updated\s+(\d{1,2}\s+[A-Za-z]+\s+\d{4})", visible, re.I)
    if not update_match:
        raise ValueError("HKEX newly-listed securities update date was not found")
    updated = datetime.strptime(update_match.group(1), "%d %b %Y").date().isoformat()
    output: list[dict[str, Any]] = []
    for row in re.findall(r"<tr\b[^>]*>(.*?)</tr>", text, re.I | re.S):
        cells = [
            clean_text(re.sub(r"<[^>]+>", " ", cell))
            for cell in re.findall(r"<td\b[^>]*>(.*?)</td>", row, re.I | re.S)
        ]
        if len(cells) < 10 or not re.fullmatch(r"\d{2}/\d{2}/\d{4}\*?", cells[0]):
            continue
        listing_date = datetime.strptime(cells[0].rstrip("*"), "%d/%m/%Y").date().isoformat()
        output.append({
            "listing_date": listing_date,
            "tentative": cells[0].endswith("*"),
            "company_name": cells[1],
            "hk_code": cells[2].zfill(5),
            "stamp_duty_equity": cells[6] == "S",
            "action": cells[8],
            "related_code": cells[9],
        })
    if not output:
        raise ValueError("HKEX newly-listed securities table was empty")
    return output, updated


def listing_continuity_parent(directory: Path, snapshot_day: date) -> tuple[dict[str, Any], str]:
    """Only a byte-identical, content-addressed successful snapshot may bridge a window."""
    payload = (directory / "latest.json").read_bytes()
    digest = hashlib.sha256(payload).hexdigest()
    parent = json.loads(payload)
    day = parent["snapshot_date"]
    if day > snapshot_day.isoformat():
        raise ValueError("Listing continuity parent is from the future")
    archives = list(directory.glob(f"{day}--*--{digest[:12]}.json"))
    if not any(path.read_bytes() == payload for path in archives):
        raise ValueError("Listing continuity parent has no matching immutable archive")
    freshness = parent["quality"]["source_freshness"]
    cutoff = freshness.get("hkex_newly_listed_securities_as_of")
    if not cutoff or cutoff > day:
        raise ValueError("Listing continuity parent has invalid official coverage dates")
    if not any(s.get("url") == HKEX_NEWLY_LISTED_SECURITIES and s.get("sha256") for s in parent["sources"]):
        raise ValueError("Listing continuity parent lacks the original trading-list provenance")
    return parent, digest


def fill_verified_nlr_gaps(
    fetcher: Fetcher,
    listings: list[dict[str, Any]],
    current_sets: dict[str, list[dict[str, Any]]],
    snapshot_day: date,
    nlr_as_of: str | None,
    continuity_directory: Path | None = None,
) -> tuple[str | None, list[str]]:
    """Reconcile the two-week trading list with NLR and verified allotments."""
    if not nlr_as_of:
        raise ValueError("Current-year NLR has no publication cutoff")
    payload = fetcher.save(
        HKEX_NEWLY_LISTED_SECURITIES,
        "hkex/newly-listed-securities.html",
        source="HKEX",
    )
    rows, live_as_of = parse_newly_listed_securities(payload)
    payload_hash = hashlib.sha256(payload).hexdigest()
    # The rolling page can disappear. Preserve each actual response, not just its URL.
    archive = RAW / "hkex" / "trading-list-history" / f"{live_as_of}--{payload_hash}.html"
    if isinstance(fetcher, Fetcher):
        archive.parent.mkdir(parents=True, exist_ok=True)
        if not archive.exists():
            with archive.open("xb") as handle:
                handle.write(payload)
    continuity = {"mode": "fresh-nlr-and-trading-list", "current_trading_list_sha256": payload_hash,
                  "parent_snapshot_date": None, "parent_sha256": None, "parent_coverage_through": None,
                  "carried_listing_codes": [], "note": "年度报告与近期上市名录直接衔接"}
    fetcher.listing_continuity = continuity
    if live_as_of > snapshot_day.isoformat():
        raise ValueError(f"HKEX trading-list update is after snapshot date: {live_as_of}")
    earliest = min(row["listing_date"] for row in rows)
    if earliest > (date.fromisoformat(nlr_as_of) + timedelta(days=1)).isoformat():
        if continuity_directory is None:
            raise ValueError(f"HKEX NLR and two-week trading list have an uncovered interval: {nlr_as_of} to {earliest}")
        parent, digest = listing_continuity_parent(continuity_directory, snapshot_day)
        prior = parent["quality"]["source_freshness"]
        through = prior["hkex_newly_listed_securities_as_of"]
        if through < earliest or through > live_as_of or prior["hkex_new_listing_report_as_of"] > nlr_as_of:
            raise ValueError("Listing continuity parent does not overlap the new rolling window, or source regressed")
        verified_codes = set(prior.get("verified_post_nlr_listing_codes", []))
        prior_gap = [r for r in parent["listings"] if prior["hkex_new_listing_report_as_of"] < r["listing_date"] <= through]
        if {r["hk_code"] for r in prior_gap} != verified_codes:
            raise ValueError("Listing continuity parent post-NLR rows do not reconcile with its verified registry")
        # Reconcile the original bridge before trimming what the new NLR absorbed.
        for old in prior_gap:
            if old["listing_date"] <= nlr_as_of and not any(
                r["hk_code"] == old["hk_code"] and r["listing_date"] == old["listing_date"]
                and (not old.get("company_name") or r.get("company_name") == old["company_name"])
                for r in listings
            ):
                raise ValueError("New NLR does not reconcile an absorbed verified listing")
        carry = [r for r in prior_gap if r["listing_date"] > nlr_as_of]
        for old in carry:
            if urllib.parse.urlparse(old["source_url"]).hostname not in {"www1.hkexnews.hk", "www.hkexnews.hk"}:
                raise ValueError("Listing continuity row lacks official issuer evidence")
            evidence = next((s for s in parent['sources'] if s.get('url') == old['source_url'] and '/final-allotments/' in s.get('local_file', '')), None)
            if not evidence:
                raise ValueError('Listing continuity parent lacks final allotment provenance')
            pdf = fetcher.save(old['source_url'], f"hkex/final-allotments/{old['hk_code']}-{old['listing_date']}.pdf", source='HKEXnews', immutable=True)
            if not pdf.startswith(b'%PDF') or hashlib.sha256(pdf).hexdigest() != evidence['sha256']:
                raise ValueError('Retained final allotment content differs from successful snapshot')
            if old["listing_date"] >= earliest and not any(
                r["hk_code"] == old["hk_code"] and r["listing_date"] == old["listing_date"]
                and not r["tentative"] and r["action"] == "New Listing" for r in rows
            ):
                raise ValueError(f"Historical/current trading-list conflict for {old['hk_code']}")
            if not any(r["hk_code"] == old["hk_code"] for r in listings):
                listings.append(dict(old))
        continuity.update(mode="immutable-successful-snapshot-bridge", parent_snapshot_date=parent["snapshot_date"],
                          parent_sha256=digest, parent_coverage_through=through,
                          carried_listing_codes=sorted(r["hk_code"] for r in carry),
                          note="复用已验证成功快照中的历史官方证据，与本次滚动名录重叠衔接；不称为本次重新下载历史名录")
    known_codes = {row["hk_code"] for row in listings}
    listed_application_codes = {
        item.get("hk_code")
        for name, items in current_sets.items() if name.startswith("applisted_")
        for item in items
    }
    added: list[str] = list(continuity["carried_listing_codes"])
    for row in rows:
        code = row["hk_code"]
        if (
            row["tentative"] or row["listing_date"] <= nlr_as_of
            or row["listing_date"] > min(live_as_of, snapshot_day.isoformat())
            or row["action"] != "New Listing" or not row["stamp_duty_equity"]
            or row["related_code"] or not code.isdigit() or int(code) >= 10000
            or code in known_codes
        ):
            continue
        if code not in listed_application_codes:
            raise ValueError(f"Unclassified post-NLR equity admission {code} on {row['listing_date']}")
        verified = VERIFIED_NLR_GAP_FILLS.get(code)
        if not verified or verified["listing_date"] != row["listing_date"]:
            raise ValueError(
                f"HKEX confirms listed equity {code} on {row['listing_date']}, "
                "but final IPO terms have not been verified; publication held"
            )
        pdf = fetcher.save(
            verified["source_url"],
            f"hkex/final-allotments/{code}-{row['listing_date']}.pdf",
            source="HKEXnews",
            immutable=True,
        )
        if not pdf.startswith(b"%PDF") or len(pdf) < 10_000:
            raise ValueError(f"HKEX final allotment document invalid for {code}")
        price = verified["offer_price_hkd"]
        public = round(verified["public_offer_shares"] * price, 2)
        international = round(verified["international_placing_shares"] * price, 2)
        listings.append({
            "year": verified["year"],
            "sequence": max((item["sequence"] for item in listings if item["year"] == verified["year"]), default=0) + 1,
            "hk_code": code,
            "company_name": verified["company_name"],
            "prospectus_date": verified["prospectus_date"],
            "listing_date": row["listing_date"],
            "sponsors": verified["sponsors"],
            "reporting_accountant": verified["reporting_accountant"],
            "property_valuer": verified["property_valuer"],
            "public_offer_hkd": public,
            "international_placing_hkd": international,
            "total_proceeds_hkd": round(public + international, 2),
            "offer_price_hkd": price,
            "is_h_share_name": verified["is_h_share_name"],
            "market": "主板",
            "source_url": verified["source_url"],
            "source_as_of": live_as_of,
            "source_grade": "A",
            "source_detail": "HKEX实盘上市名录 + HKEXnews公司配发结果；年度NLR待更新",
        })
        known_codes.add(code)
        added.append(code)
    return live_as_of, added


def _attachment_size_bytes(value: str) -> int:
    match = re.search(r"([\d.]+)\s*(KB|MB|GB)", clean_text(value), re.I)
    if not match:
        return 0
    multiplier = {"KB": 1024, "MB": 1024 ** 2, "GB": 1024 ** 3}[match.group(2).upper()]
    return round(float(match.group(1)) * multiplier)


def _parse_listing_document(payload: bytes, expected_date: str | None = None) -> dict[str, Any] | None:
    """Select the final prospectus from an issuer's official HKEXnews title results."""
    text = payload.decode("utf-8", "replace")
    candidates: list[dict[str, Any]] = []
    for row in re.findall(r"<tr\b[^>]*>(.*?)</tr>", text, re.I | re.S):
        date_match = re.search(r"release-time[^>]*>.*?(\d{2}/\d{2}/\d{4})", row, re.I | re.S)
        headline_match = re.search(r"class=[\"']headline[\"'][^>]*>(.*?)</div>", row, re.I | re.S)
        link_match = re.search(
            r"<a\b[^>]*href=[\"']([^\"']+)[\"'][^>]*>(.*?)</a>",
            row,
            re.I | re.S,
        )
        if not date_match or not headline_match or not link_match:
            continue
        release_date = datetime.strptime(date_match.group(1), "%d/%m/%Y").date().isoformat()
        headline = clean_text(re.sub(r"<[^>]+>", " ", headline_match.group(1)))
        document_title = clean_text(re.sub(r"<[^>]+>", " ", link_match.group(2)))
        is_listing_document = "上市文件" in headline or "LISTING DOCUMENT" in headline.upper()
        if not is_listing_document:
            continue
        size_match = re.search(r"attachment_filesize[^>]*>(.*?)</span>", row, re.I | re.S)
        candidates.append({
            "original_document_url": urllib.parse.urljoin(HKEX_TITLE_SEARCH, html.unescape(link_match.group(1))),
            "original_document_title": document_title or "招股章程",
            "original_document_date": release_date,
            "original_document_size_bytes": _attachment_size_bytes(size_match.group(1) if size_match else ""),
            "original_document_source": "HKEXnews上市文件",
            "date_distance_days": abs((date.fromisoformat(release_date) - date.fromisoformat(expected_date)).days) if expected_date else None,
        })
    if not candidates:
        return None
    candidates.sort(
        key=lambda item: (
            "招股" in item["original_document_title"] or "發售" in item["original_document_title"] or "发售" in item["original_document_title"],
            item["original_document_size_bytes"],
            -(item["date_distance_days"] or 0),
        ),
        reverse=True,
    )
    return candidates[0]


def enrich_listing_original_documents(fetcher: Fetcher, listings: list[dict[str, Any]]) -> None:
    """Attach immutable per-company final listing files while retaining NLR provenance."""
    active_payload = fetcher.save(
        HKEX_ACTIVE_STOCKS,
        "hkex/title-search/active-stocks.json",
        source="HKEXnews",
    )
    inactive_payload = fetcher.save(
        HKEX_INACTIVE_STOCKS,
        "hkex/title-search/inactive-stocks.json",
        source="HKEXnews",
    )
    stock_items: list[dict[str, Any]] = []
    for payload in (active_payload, inactive_payload):
        stock_items.extend(json.loads(payload.decode("utf-8-sig")))
    simplified_names = simplify_texts([clean_text(item.get("n")) for item in stock_items])
    stock_ids: defaultdict[str, list[tuple[str, str]]] = defaultdict(list)
    for item, simplified_name in zip(stock_items, simplified_names):
        code = str(item.get("c", "")).zfill(5)
        stock_id = str(item.get("i", ""))
        if code and stock_id:
            stock_ids[code].append((stock_id, simplified_name))

    def process(listing: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any] | None]:
        known = KNOWN_FINAL_LISTING_DOCUMENTS.get((int(listing["year"]), listing["hk_code"]))
        if known:
            return listing, {
                "original_document_url": known["url"],
                "original_document_title": known["title"],
                "original_document_date": known["date"],
                "original_document_size_bytes": 0,
                "original_document_source": "HKEXnews上市文件（已核验历史直链）",
            }
        if (listing["hk_code"] in KNOWN_GEM_TO_MAIN_CODES or listing["hk_code"] == "06676") and not listing.get("total_proceeds_hkd"):
            return listing, None
        prospectus_date = listing.get("prospectus_date")
        candidates = stock_ids.get(listing["hk_code"], [])
        if not candidates:
            return listing, None
        target_name = normalize_company(listing["company_name"])
        candidates = sorted(
            candidates,
            key=lambda item: difflib.SequenceMatcher(None, target_name, normalize_company(item[1])).ratio(),
            reverse=True,
        )

        try:
            target_day = date.fromisoformat(prospectus_date)
        except (TypeError, ValueError):
            try:
                target_day = date.fromisoformat(listing.get("listing_date"))
            except (TypeError, ValueError):
                return listing, None
            ranges = [(target_day - timedelta(days=28), target_day, "listing-window")]
            if os.environ.get("HKIPO_FORCE_REFRESH") == "1":
                ranges.append((target_day - timedelta(days=180), target_day, "broad-listing-window"))
            expected_date = None
        else:
            ranges = [
                (target_day, target_day, "exact"),
                (target_day - timedelta(days=3), target_day + timedelta(days=3), "prospectus-window"),
            ]
            try:
                listing_day = date.fromisoformat(listing.get("listing_date"))
            except (TypeError, ValueError):
                listing_day = target_day + timedelta(days=90)
            if os.environ.get("HKIPO_FORCE_REFRESH") == "1":
                ranges.append((min(target_day - timedelta(days=45), listing_day - timedelta(days=180)), listing_day, "broad-listing-window"))
            expected_date = prospectus_date

        for candidate_index, (stock_id, _) in enumerate(candidates[:3]):
            for start_day, end_day, suffix in ranges:
                query = urllib.parse.urlencode({
                    "category": "0",
                    "lang": "ZH",
                    "market": "SEHK",
                    "stockId": stock_id,
                    "from": start_day.strftime("%Y%m%d"),
                    "to": end_day.strftime("%Y%m%d"),
                })
                url = f"{HKEX_TITLE_SEARCH}?{query}"
                if len(candidates) == 1:
                    cache_name = (
                        f"{listing['hk_code']}-{start_day:%Y%m%d}.html"
                        if suffix == "exact"
                        else f"{listing['hk_code']}-{start_day:%Y%m%d}-{end_day:%Y%m%d}-{suffix}.html"
                    )
                else:
                    cache_name = (
                        f"{listing['hk_code']}-{start_day:%Y%m%d}-s{stock_id}.html"
                        if suffix == "exact"
                        else f"{listing['hk_code']}-{start_day:%Y%m%d}-{end_day:%Y%m%d}-{suffix}-s{stock_id}.html"
                    )
                payload = fetcher.save(
                    url,
                    f"hkex/title-search/{listing['year']}/{cache_name}",
                    referer=HKEX_TITLE_SEARCH,
                    source="HKEXnews",
                    immutable=True,
                )
                document = _parse_listing_document(payload, expected_date)
                if not document and os.environ.get("HKIPO_FORCE_REFRESH", "1") == "1":
                    payload = fetcher.save(
                        url, f"hkex/title-search/{listing['year']}/{cache_name}",
                        referer=HKEX_TITLE_SEARCH, source="HKEXnews", immutable=False,
                    )
                    document = _parse_listing_document(payload, expected_date)
                if document:
                    document.pop("date_distance_days", None)
                    return listing, document
        return listing, None

    worker_count = min(12, max(1, len(listings)))
    with concurrent.futures.ThreadPoolExecutor(max_workers=worker_count) as executor:
        for listing, document in executor.map(process, listings):
            listing["original_document_url"] = None
            listing["original_document_title"] = None
            listing["original_document_date"] = None
            listing["original_document_size_bytes"] = None
            listing["original_document_source"] = None
            if document:
                listing.update(document)
                listing["original_document_status"] = "direct"
                listing["original_document_unavailable_reason"] = None
            elif listing["hk_code"] in KNOWN_SPAC_IPO_CODES:
                listing["original_document_status"] = "pending_verification"
                listing["original_document_unavailable_reason"] = SPAC_DOCUMENT_PENDING_REASON
            else:
                listing["original_document_status"] = "unmatched"
                listing["original_document_unavailable_reason"] = "港交所公司级最终上市文件尚未匹配；保留年度新上市报告作为统计依据。"


def preferred_application_document(application: dict[str, Any]) -> str | None:
    documents = application.get("documents") or []
    candidates = []
    for document in documents:
        url = document.get("full_document_url") or document.get("multi_file_url")
        if not url:
            continue
        label = f"{document.get('document_type') or ''} {document.get('full_document_name') or ''}".upper()
        if "PHIP" in label or "聆訊後" in label or "聆讯后" in label:
            priority = 3
        elif "申請版本" in label or "申请版本" in label or "APPLICATION PROOF" in label:
            priority = 2
        else:
            priority = 1
        candidates.append((priority, document.get("date") or "", url))
    if not candidates:
        return application.get("warning_url")
    return max(candidates)[2]


def _parse_hkex_ipo_processing_report(payload: bytes, url: str, published_on: date) -> dict[str, Any]:
    text = re.sub(r"_+", " ", _visible_html_text(payload))
    as_of_match = re.search(
        r"Initial Public Offering Applications\s*\(As at\s+(\d{1,2}\s+[A-Za-z]+\s+\d{4})\)",
        text,
        re.I,
    )
    if not as_of_match:
        raise ValueError(f"Cannot identify the HKEX IPO processing report date: {url}")
    as_of = datetime.strptime(as_of_match.group(1), "%d %B %Y").date()

    row_match = re.search(
        r"3\.\s*Under processing\s+([\d,]+)\s+([\d,]+)\s+([\d,]+)\s+([\d,]+)",
        text,
        re.I,
    )
    if not row_match:
        raise ValueError(f"Cannot parse the HKEX under-processing row: {url}")
    main_board, gem, others, total = (int(value.replace(",", "")) for value in row_match.groups())
    if main_board + gem + others != total:
        raise ValueError(f"HKEX under-processing components do not reconcile: {url}")

    return {
        "label": "港交所月报审核处理中申请",
        "as_of": as_of.isoformat(),
        "published_on": published_on.isoformat(),
        "under_processing_total": total,
        "components": {
            "main_board": main_board,
            "gem": gem,
            "others": others,
        },
        "source_url": url,
        "counting_rule": (
            "港交所《首次公开招股申请、除牌及停牌报告》中“Under processing”状态的申请宗数；"
            "包括主板、GEM及其他类别，并按报告脚注涵盖转板、投资工具、De-SPAC继承公司、"
            "视作新申请人及反向收购等监管处理类别。"
        ),
    }


def fetch_hkex_ipo_processing_statistics(fetcher: Fetcher, snapshot_day: date) -> list[dict[str, Any]]:
    index_payload = fetcher.save(
        HKEX_MARKET_COMMUNICATIONS_PAGE,
        "hkex/market-communications.html",
        source="HKEX",
    )
    candidates: dict[str, tuple[date, str]] = {}
    for url, label in _html_anchors(index_payload, HKEX_MARKET_COMMUNICATIONS_PAGE):
        if "Report on Initial Public Offering Applications" not in label:
            continue
        date_match = re.search(r"/20\d{2}/(\d{6})news", url)
        if not date_match:
            continue
        published_on = datetime.strptime(date_match.group(1), "%y%m%d").date()
        if published_on <= snapshot_day:
            candidates[url] = (published_on, label)
    if not candidates:
        raise ValueError("Cannot find an HKEX IPO application monthly report in Market Communications")

    reports = []
    for url, (published_on, _) in sorted(candidates.items(), key=lambda item: item[1][0], reverse=True)[:2]:
        payload = fetcher.save(
            url,
            f"hkex/market-communications/ipo-applications-{published_on.isoformat()}.html",
            source="HKEX",
        )
        reports.append(_parse_hkex_ipo_processing_report(payload, url, published_on))
    return reports


def _extract_sponsors_from_pdf(payload: bytes) -> list[str]:
    try:
        import fitz  # PyMuPDF, part of the weekly data runtime
        with fitz.open(stream=payload, filetype="pdf") as document:
            raw_text = "\n".join(page.get_text("text") for page in document)
    except ImportError:
        try:
            import pdfplumber

            with pdfplumber.open(io.BytesIO(payload)) as document:
                raw_text = "\n".join(page.extract_text() or "" for page in document.pages)
        except Exception:
            try:
                from pypdf import PdfReader

                document = PdfReader(io.BytesIO(payload))
                raw_text = "\n".join(page.extract_text() or "" for page in document.pages)
            except Exception:
                return []
    except Exception:
        return []
    # Convert line-by-line so the PDF's column/line boundaries remain usable
    # for separating a sponsor name from its address and later advisers.
    text = simplify_texts([raw_text], preserve_whitespace=True)[0]
    text = re.sub(r"\[\s*编\s*纂\s*\]", "[编纂]", text)
    text = re.sub(r"(?<=[\u4e00-\u9fff])[ \t]+(?=[\u4e00-\u9fff])", "", text)
    start = re.search(r"(?:独家|联席)?(?:保荐人|上市代理人)(?:兼[^\n]{0,30})?", text)
    if not start:
        return []
    section = text[start.end() : start.end() + 1600]
    stop = re.search(
        r"\n\s*(?:\[编纂\]|(?:独家|联席)?整体协调人|全球协调人|账簿管理人|联席牵头经办人|(?:本公司|发行人|独家保荐人|联席保荐人|保荐人|上市代理人).*法律顾问|公司及|本公司及|发行人及|保荐人及|上市代理人及|申报会计师|核数师|物业估值师|估值代理|行业顾问|合规顾问|法律顾问)",
        section,
    )
    if stop:
        section = section[: stop.start()]
    # Sponsor names often wrap across lines or sit in adjacent PDF columns.
    # Flatten only this already-bounded block, and stop each match at the first
    # legal suffix so two adjacent firms cannot become one filter value.
    section = re.sub(r"\s*\n\s*", " ", section)
    candidates = re.findall(
        r"[\u4e00-\u9fffA-Za-z0-9（()）·•&.,，\- ]{2,100}?(?:有限责任公司|股份有限公司|有限公司|股份公司|Limited|Ltd\.?|LLP)",
        section,
        re.I,
    )
    candidates = [
        re.sub(r"^(?:及|和|与)\s*", "", clean_text(candidate).strip("-–—•·.,， "))
        for candidate in candidates
        if len(clean_text(candidate)) >= 4
        and not any(token in candidate for token in ("本公司", "发行人", "律师事务所"))
    ]
    return normalize_sponsor_names(candidates)[:6]


def enrich_application_sponsors(fetcher: Fetcher, applications: list[dict[str, Any]]) -> None:
    """Read the small 'directors and parties' AP section for sponsor names."""
    def process(application: dict[str, Any]) -> tuple[str, list[str], str | None]:
        multi_documents = [
            item for item in application.get("documents", [])
            if item.get("multi_file_url") and ("申請版本" in item.get("document_type", "") or "申请版本" in item.get("document_type", ""))
        ]
        if not multi_documents:
            return application["application_id"], [], None
        multi_documents.sort(key=lambda item: item.get("date") or "", reverse=True)
        toc_url = multi_documents[0]["multi_file_url"]
        try:
            toc = fetcher.save(
                toc_url,
                f"hkex/app-sections/{application['application_id']}/toc.html",
                source="HKEXnews AP sections",
                immutable=True,
            )
            anchors = _html_anchors(toc, toc_url)
            parties = [
                url for url, label in anchors
                if url.lower().endswith(".pdf")
                and ("各方" in label or "參與" in label or "参与" in label)
                and ("董事" in label or "參與" in label or "参与" in label)
            ]
            if not parties:
                return application["application_id"], [], None
            pdf_url = parties[0]
            pdf_payload = fetcher.save(
                pdf_url,
                f"hkex/app-sections/{application['application_id']}/parties.pdf",
                source="HKEXnews AP parties",
                immutable=True,
            )
            sponsors = _extract_sponsors_from_pdf(pdf_payload)
            return application["application_id"], sponsors, pdf_url if sponsors else None
        except Exception as error:
            print(f"Sponsor extraction skipped for {application['application_id']}: {error}", file=sys.stderr)
            return application["application_id"], [], None

    by_id = {item["application_id"]: item for item in applications}
    workers = max(1, min(int(os.environ.get("HKIPO_SPONSOR_WORKERS", "6")), 10))
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as executor:
        for index, (application_id, sponsors, source_url) in enumerate(executor.map(process, applications), start=1):
            if sponsors:
                by_id[application_id]["sponsors"] = sponsors
                by_id[application_id]["sponsor_source_url"] = source_url
            if index % 50 == 0:
                print(f"Sponsor sections processed: {index}/{len(applications)}", file=sys.stderr)


def parse_excel_seed(path: Path) -> dict[str, Any]:
    with zipfile.ZipFile(path) as book:
        workbook = ET.fromstring(book.read("xl/workbook.xml"))
        sheets_node = workbook.find(XLSX_NS + "sheets")
        selected_names = {
            sheet.attrib["name"]
            for sheet in list(sheets_node) if sheets_node is not None
            if "A to H" in sheet.attrib["name"]
        }
    sheets = xlsx_sheets(path, selected_names)
    listed: list[dict[str, Any]] = []
    pipeline: list[dict[str, Any]] = []
    for sheet_name, rows in sheets.items():
        if "A to H" not in sheet_name:
            continue
        if "上市公司" in sheet_name and "保荐人" not in sheet_name:
            for row in rows:
                hk_value = clean_text(row.get("C"))
                a_value = clean_text(row.get("D"))
                if re.fullmatch(r"\d{3,5}\.HK", hk_value, re.I) and re.fullmatch(r"\d{6}\.(?:SH|SZ|BJ)", a_value, re.I):
                    listed.append(
                        {
                            "hk_code": hk_value.split(".")[0].zfill(5),
                            "a_code": a_value[:6],
                            "exchange_hint": a_value[-2:].upper(),
                            "company_name": clean_text(row.get("E")),
                            "seed_sheet": sheet_name,
                        }
                    )
        if "交表公司" in sheet_name:
            for row in rows:
                a_value = clean_text(row.get("C"))
                if re.fullmatch(r"\d{6}\.(?:SH|SZ|BJ)", a_value, re.I):
                    pipeline.append(
                        {
                            "a_code": a_value[:6],
                            "exchange_hint": a_value[-2:].upper(),
                            "company_name": clean_text(row.get("D")),
                            "reference_application_date": clean_text(row.get("E")) or None,
                            "reference_latest_version_date": clean_text(row.get("F")) or None,
                            "seed_sheet": sheet_name,
                        }
                    )
    def unique(items: list[dict[str, Any]], keys: tuple[str, ...]) -> list[dict[str, Any]]:
        seen: set[tuple[str, ...]] = set()
        output = []
        for item in items:
            key = tuple(str(item.get(name, "")) for name in keys)
            if key not in seen:
                seen.add(key)
                output.append(item)
        return output
    return {
        "generated_at": datetime.now(HK_TZ).isoformat(timespec="seconds"),
        "role": "one-time candidate and field-mapping seed only; never a production observation source",
        "source_file_name": path.name,
        "source_sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        "listed_mappings": unique(listed, ("hk_code", "a_code")),
        "pipeline_candidates": unique(pipeline, ("a_code",)),
    }


def _stable_sse_name(value: Any) -> str:
    """Remove temporary SSE trading prefixes while preserving the official value."""
    text = clean_text(value)
    return re.sub(r"^(?:XD|XR|DR|N|C)(?=[\u3400-\u9fff])", "", text, flags=re.I)


def _cached_sse_metadata() -> dict[str, dict[str, Any]]:
    """Best-effort enrichment only; membership always comes from the current source."""
    output: dict[str, dict[str, Any]] = {}
    for stock_type in ("1", "8"):
        path = RAW / f"a-share/sse-{stock_type}.jsonp"
        if not path.exists():
            continue
        try:
            data = _parse_jsonp(path.read_bytes())
        except Exception:
            continue
        for row in data.get("result") or data.get("pageHelp", {}).get("data", []):
            code = clean_text(row.get("A_STOCK_CODE"))
            full_name = clean_text(row.get("FULL_NAME"))
            industry = clean_text(row.get("CSRC_CODE_DESC"))
            output[code] = {
                "full_name": None if "�" in full_name else full_name or None,
                "industry": None if "�" in industry else industry or None,
            }
    return output


def load_manual_sse(
    fetcher: Fetcher,
    path: Path,
    expected_as_of: str,
) -> list[dict[str, Any]]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if payload.get("as_of_date") != expected_as_of:
        raise ValueError(
            f"Manual SSE export is dated {payload.get('as_of_date')}, expected {expected_as_of}"
        )
    records = payload.get("records") or []
    if len(records) < 2_000:
        raise ValueError(f"Manual SSE export is unexpectedly small: {len(records)} rows")
    codes = [clean_text(item.get("a_code")) for item in records]
    if any(not re.fullmatch(r"\d{6}", code) for code in codes) or len(codes) != len(set(codes)):
        raise ValueError("Manual SSE export contains invalid or duplicate A-share codes")

    for item in payload.get("files") or []:
        local_path = ROOT / str(item.get("local_file", ""))
        if not local_path.is_file():
            raise FileNotFoundError(local_path)
        raw = local_path.read_bytes()
        digest = hashlib.sha256(raw).hexdigest()
        if digest != item.get("sha256") or len(raw) != int(item.get("bytes") or -1):
            raise ValueError(f"Manual SSE source hash mismatch: {local_path}")
        fetcher.manifest.append({
            "source": "SSE official stock-list export",
            "url": payload.get("source_url") or SSE_REFERER,
            "local_file": local_path.relative_to(ROOT).as_posix(),
            "bytes": len(raw),
            "sha256": digest,
            "fetched_at": item.get("downloaded_at") or payload.get("imported_at"),
            "source_as_of": expected_as_of,
            "cache_status": "manual-official-export",
            "board": item.get("board"),
            "record_count": item.get("record_count"),
        })

    cached = _cached_sse_metadata()
    output = []
    for row in records:
        code = clean_text(row.get("a_code"))
        metadata = cached.get(code, {})
        official_name = clean_text(row.get("short_name"))
        extended_name = clean_text(row.get("extended_name"))
        output.append({
            "a_code": code,
            "exchange": "SSE",
            "board": clean_text(row.get("board")),
            "short_name": _stable_sse_name(extended_name or official_name),
            "official_short_name": official_name,
            "full_name": metadata.get("full_name") or _stable_sse_name(extended_name or official_name),
            "english_full_name": clean_text(row.get("english_full_name")) or None,
            "industry": metadata.get("industry"),
            "total_shares": None,
            "listing_date": row.get("listing_date"),
            "official_url": row.get("official_url") or (
                "https://www.sse.com.cn/assortment/stock/list/info/company/"
                f"index.shtml?COMPANY_CODE={code}"
            ),
            "source_as_of": expected_as_of,
        })
    return output


def fetch_sse(
    fetcher: Fetcher,
    manual_path: Path | None = None,
    expected_as_of: str | None = None,
) -> list[dict[str, Any]]:
    if manual_path:
        if not expected_as_of:
            raise ValueError("Manual SSE import requires an explicit snapshot date")
        return load_manual_sse(fetcher, manual_path, expected_as_of)

    output: list[dict[str, Any]] = []
    for stock_type, board in (("1", "上交所主板"), ("8", "科创板")):
        params = {
            "jsonCallBack": "jsonpCallback",
            "isPagination": "true",
            "sqlId": "COMMON_SSE_CP_GPJCTPZ_GPLB_GP_L",
            "STOCK_TYPE": stock_type,
            "REG_PROVINCE": "",
            "CSRC_CODE": "",
            "STOCK_CODE": "",
            "COMPANY_STATUS": "2,4,5,7,8",
            "type": "inParams",
            "pageHelp.cacheSize": 1,
            "pageHelp.beginPage": 1,
            "pageHelp.pageSize": 5000,
            "pageHelp.pageNo": 1,
        }
        url = SSE_QUERY + "?" + urllib.parse.urlencode(params)
        payload = fetcher.save(url, f"a-share/sse-{stock_type}.jsonp", referer=SSE_REFERER, source="SSE")
        text = payload.decode("utf-8", "replace")
        data = json.loads(text[text.index("(") + 1 : text.rindex(")")])
        rows = data.get("result") or data.get("pageHelp", {}).get("data", [])
        for row in rows:
            output.append(
                {
                    "a_code": row.get("A_STOCK_CODE"),
                    "exchange": "SSE",
                    "board": board,
                    "short_name": clean_text(row.get("SEC_NAME_CN")),
                    "full_name": clean_text(row.get("FULL_NAME")),
                    "industry": clean_text(row.get("CSRC_CODE_DESC")) or None,
                    "total_shares": None,
                    "listing_date": excel_date(row.get("LIST_DATE", "")) if str(row.get("LIST_DATE", "")).isdigit() and len(str(row.get("LIST_DATE"))) < 6 else (
                        f"{str(row.get('LIST_DATE'))[:4]}-{str(row.get('LIST_DATE'))[4:6]}-{str(row.get('LIST_DATE'))[6:8]}" if len(str(row.get("LIST_DATE", ""))) == 8 else None
                    ),
                    "official_url": f"https://www.sse.com.cn/assortment/stock/list/info/company/index.shtml?COMPANY_CODE={row.get('A_STOCK_CODE')}",
                }
            )
    return output


def fetch_szse(fetcher: Fetcher, verified_through: str | None = None) -> list[dict[str, Any]]:
    params = {"SHOWTYPE": "xlsx", "CATALOGID": "1110", "TABKEY": "tab1"}
    url = SZSE_LIST + "?" + urllib.parse.urlencode(params)
    destination = RAW / "a-share/szse.xlsx"
    if verified_through:
        if not destination.exists():
            raise FileNotFoundError(destination)
        payload = destination.read_bytes()
        fetcher.manifest.append({
            "source": "SZSE official stock list",
            "url": url,
            "local_file": destination.relative_to(ROOT).as_posix(),
            "bytes": len(payload),
            "sha256": hashlib.sha256(payload).hexdigest(),
            "fetched_at": datetime.fromtimestamp(destination.stat().st_mtime, HK_TZ).isoformat(timespec="seconds"),
            "source_as_of": datetime.fromtimestamp(destination.stat().st_mtime, HK_TZ).date().isoformat(),
            "cache_status": "reused-verified-no-change",
            "change_control_verified_through": verified_through,
            "verification_url": SZSE_COMPANY_NOTICES,
        })
    else:
        payload = fetcher.save(url, "a-share/szse.xlsx", referer=SZSE_REFERER, source="SZSE")
    rows = next(iter(xlsx_sheets(payload).values()))
    header_index = -1
    columns: dict[str, str] = {}
    for index, row in enumerate(rows[:20]):
        for column, value in row.items():
            if "A股代码" in clean_text(value) or clean_text(value) == "证券代码":
                header_index = index
                columns["code"] = column
            if "A股简称" in clean_text(value) or clean_text(value) == "证券简称":
                columns["name"] = column
            if "A股上市日期" in clean_text(value) or clean_text(value) == "上市日期":
                columns["date"] = column
            if clean_text(value) == "板块":
                columns["board"] = column
        if header_index >= 0 and "code" in columns and "name" in columns:
            break
    if header_index < 0:
        raise ValueError("Unable to find SZSE stock-list headers")
    output = []
    for row in rows[header_index + 1 :]:
        code = clean_text(row.get(columns["code"]))
        if not re.fullmatch(r"\d{6}", code):
            continue
        name = re.sub(r"<[^>]+>", "", clean_text(row.get(columns["name"])))
        output.append(
            {
                "a_code": code,
                "exchange": "SZSE",
                "board": clean_text(row.get(columns.get("board", ""))) or ("创业板" if code.startswith("30") else "深交所主板"),
                "short_name": name,
                "full_name": clean_text(row.get("B")) or None,
                "industry": clean_text(row.get("R")) or None,
                "total_shares": float(clean_text(row.get("H")).replace(",", "")) if clean_text(row.get("H")).replace(",", "").replace(".", "", 1).isdigit() else None,
                "listing_date": clean_text(row.get(columns.get("date", ""))) or None,
                "official_url": f"https://www.szse.cn/certificate/individual/index.html?code={code}",
            }
        )
    return output


def _parse_jsonp(payload: bytes) -> dict[str, Any]:
    text = payload.decode("utf-8", "replace")
    return json.loads(text[text.index("(") + 1 : text.rindex(")")])


def fetch_a_share_market_data(
    fetcher: Fetcher,
    a_shares: list[dict[str, Any]],
    required_codes: set[str],
    snapshot_date: date,
    *,
    reuse_sse_cache: bool = False,
    reuse_szse_cache: bool = False,
) -> dict[str, dict[str, Any]]:
    """Fetch official latest market values only for A-to-H matched securities."""
    a_by_code = {item["a_code"]: item for item in a_shares if item.get("a_code")}
    market: dict[str, dict[str, Any]] = {}

    for code in sorted(required_codes):
        security = a_by_code.get(code)
        if not security or security.get("exchange") != "SSE":
            continue
        params = {
            "jsonCallBack": "jsonpCallback",
            "isPagination": "false",
            "sqlId": "COMMON_SSE_CP_GPJCTPZ_GPLB_CJGK_MRGK_C",
            "SEC_CODE": code,
            "TX_DATE": "",
            "type": "inParams",
        }
        url = SSE_QUERY + "?" + urllib.parse.urlencode(params)
        try:
            relative_path = f"a-share/market/sse-{code}.jsonp"
            destination = RAW / relative_path
            if reuse_sse_cache:
                if not destination.exists():
                    continue
                payload = destination.read_bytes()
            else:
                payload = fetcher.save(url, relative_path, referer=SSE_REFERER, source="SSE market data")
            row = (_parse_jsonp(payload).get("result") or [None])[0]
            if row:
                total_value_10k = float(str(row.get("TOTAL_VALUE", "0")).replace(",", "") or 0)
                market_date = f"{row['TX_DATE'][:4]}-{row['TX_DATE'][4:6]}-{row['TX_DATE'][6:8]}"
                market[code] = {
                    "a_close_rmb": float(row["CLOSE_PRICE"]) if row.get("CLOSE_PRICE") not in (None, "-") else None,
                    "a_market_cap_rmb_bn": round(total_value_10k / 100_000, 2),
                    "market_data_date": market_date,
                    "market_data_source_url": url,
                }
                if reuse_sse_cache:
                    fetcher.manifest.append({
                        "source": "SSE market data",
                        "url": url,
                        "local_file": destination.relative_to(ROOT).as_posix(),
                        "bytes": len(payload),
                        "sha256": hashlib.sha256(payload).hexdigest(),
                        "fetched_at": datetime.fromtimestamp(destination.stat().st_mtime, HK_TZ).isoformat(timespec="seconds"),
                        "source_as_of": market_date,
                        "cache_status": "reused-last-official-close",
                    })
        except Exception as error:
            print(f"SSE market data skipped for {code}: {error}", file=sys.stderr)

    sz_codes = {code for code in required_codes if a_by_code.get(code, {}).get("exchange") == "SZSE"}
    if sz_codes:
        payload = None
        used_date = None
        used_url = None
        if reuse_szse_cache:
            candidates = sorted(
                (
                    path for path in (RAW / "a-share/market").glob("szse-????-??-??.xlsx")
                    if path.stem.removeprefix("szse-") <= snapshot_date.isoformat()
                ),
                key=lambda path: path.stem,
                reverse=True,
            )
            if candidates:
                destination = candidates[0]
                used_date = date.fromisoformat(destination.stem.removeprefix("szse-"))
                params = {
                    "SHOWTYPE": "xlsx",
                    "CATALOGID": "1815_stock_snapshot",
                    "TABKEY": "tab1",
                    "txtBeginDate": used_date.isoformat(),
                    "txtEndDate": used_date.isoformat(),
                }
                used_url = SZSE_LIST + "?" + urllib.parse.urlencode(params)
                payload = destination.read_bytes()
                fetcher.manifest.append({
                    "source": "SZSE market data",
                    "url": used_url,
                    "local_file": destination.relative_to(ROOT).as_posix(),
                    "bytes": len(payload),
                    "sha256": hashlib.sha256(payload).hexdigest(),
                    "fetched_at": datetime.fromtimestamp(destination.stat().st_mtime, HK_TZ).isoformat(timespec="seconds"),
                    "source_as_of": used_date.isoformat(),
                    "cache_status": "reused-last-official-close",
                })
        else:
            for days_back in range(0, 8):
                candidate = snapshot_date - timedelta(days=days_back)
                params = {
                    "SHOWTYPE": "xlsx",
                    "CATALOGID": "1815_stock_snapshot",
                    "TABKEY": "tab1",
                    "txtBeginDate": candidate.isoformat(),
                    "txtEndDate": candidate.isoformat(),
                }
                url = SZSE_LIST + "?" + urllib.parse.urlencode(params)
                try:
                    candidate_payload = fetcher.get(url, referer=SZSE_MARKET_REFERER)
                    candidate_rows = next(iter(xlsx_sheets(candidate_payload).values()))
                    if len(candidate_rows) > 1:
                        payload, used_date, used_url = candidate_payload, candidate, url
                        destination = RAW / f"a-share/market/szse-{candidate.isoformat()}.xlsx"
                        destination.parent.mkdir(parents=True, exist_ok=True)
                        destination.write_bytes(payload)
                        fetcher.manifest.append({
                            "source": "SZSE market data",
                            "url": url,
                            "local_file": destination.relative_to(ROOT).as_posix(),
                            "bytes": len(payload),
                            "sha256": hashlib.sha256(payload).hexdigest(),
                            "fetched_at": datetime.now(HK_TZ).isoformat(timespec="seconds"),
                            "source_as_of": candidate.isoformat(),
                            "cache_status": "downloaded",
                        })
                        break
                except Exception:
                    continue
        if payload and used_date and used_url:
            rows = next(iter(xlsx_sheets(payload).values()))
            for row in rows[1:]:
                code = clean_text(row.get("B"))
                if code not in sz_codes:
                    continue
                security = a_by_code[code]
                try:
                    close = float(clean_text(row.get("H")).replace(",", ""))
                except ValueError:
                    close = None
                shares = security.get("total_shares")
                market[code] = {
                    "a_close_rmb": close,
                    "a_market_cap_rmb_bn": round(close * shares / 1_000_000_000, 2) if close is not None and shares else None,
                    "market_data_date": used_date.isoformat(),
                    "market_data_source_url": used_url,
                }
    return market


def market_cap_band(value: float | None) -> str:
    if value is None:
        return "待官方行情"
    if value < 10:
        return "100亿元以下"
    if value < 20:
        return "100–200亿元"
    if value < 50:
        return "200–500亿元"
    if value < 100:
        return "500–1,000亿元"
    return "1,000亿元以上"


def apply_a_share_model(rows: list[dict[str, Any]], market: dict[str, dict[str, Any]]) -> None:
    for row in rows:
        fields = market.get(row.get("a_code"), {})
        row.update(fields)
        cap = row.get("a_market_cap_rmb_bn")
        row["a_market_cap_band"] = market_cap_band(cap)
        if cap is None:
            row["estimated_h_valuation_rmb_bn"] = None
            row["estimated_base_issue_rmb_bn"] = None
            row["estimated_max_issue_rmb_bn"] = None
            continue
        h_value = cap * (1 - MODEL_HA_DISCOUNT_PCT / 100)
        base = h_value * MODEL_ISSUE_RATIO_PCT / 100
        row["estimated_h_valuation_rmb_bn"] = round(h_value, 2)
        row["estimated_base_issue_rmb_bn"] = round(base, 2)
        row["estimated_max_issue_rmb_bn"] = round(base * (1 + MODEL_GREENSHOE_PCT / 100), 2)


def match_application(company_name: str, applications: list[dict[str, Any]]) -> dict[str, Any] | None:
    target = normalize_company(company_name)
    if not target:
        return None
    exact = [item for item in applications if normalize_company(item["company_name"]) == target]
    if len(exact) == 1:
        return exact[0]
    contained = [
        item
        for item in applications
        if min(len(target), len(normalize_company(item["company_name"]))) >= 4
        and (target in normalize_company(item["company_name"]) or normalize_company(item["company_name"]) in target)
    ]
    if len(contained) == 1:
        return contained[0]
    scored = sorted(
        [(
            difflib.SequenceMatcher(None, target, normalize_company(item["company_name"])).ratio(),
            item,
        )
        for item in applications
        if normalize_company(item["company_name"])
        ],
        key=lambda pair: pair[0],
    )
    if scored and scored[-1][0] >= 0.58 and (len(scored) == 1 or scored[-1][0] - scored[-2][0] >= 0.08):
        return scored[-1][1]
    return None


def match_a_share(company_name: str, a_shares: list[dict[str, Any]]) -> dict[str, Any] | None:
    target = normalize_company(company_name)
    if not target:
        return None
    matches = []
    for item in a_shares:
        full_name = normalize_company(item.get("full_name") or "")
        short_name = normalize_company(item.get("short_name") or "")
        full_similarity = difflib.SequenceMatcher(None, target, full_name).ratio() if full_name else 0
        if full_name == target or full_similarity >= 0.92:
            matches.append(item)
        elif short_name and min(len(short_name), len(target)) >= 4 and short_name in target and full_similarity >= 0.92:
            matches.append(item)
    unique = {item["a_code"]: item for item in matches}
    return next(iter(unique.values())) if len(unique) == 1 else None


def name_cross_check(primary: str, *counterpart_names: str) -> str:
    target = normalize_company(primary)
    counterparts = [normalize_company(name) for name in counterpart_names if normalize_company(name)]
    if not target or not counterparts:
        return "代码核验，名称字段不足"
    if target in counterparts:
        return "代码与公司名双重一致"
    best = max(difflib.SequenceMatcher(None, target, item).ratio() for item in counterparts)
    return "代码一致，名称近似" if best >= 0.92 else "代码一致，名称需人工复核"


def official_identity_check(company_name: str, a_share: dict[str, Any]) -> str:
    label = name_cross_check(company_name, a_share.get("full_name") or "", a_share.get("short_name") or "")
    if label == "代码一致，名称需人工复核":
        alias = OFFICIAL_NAME_ALIASES.get(a_share["a_code"], {})
        if normalize_company(company_name) in {normalize_company(item) for item in alias.get("names", [])}:
            return "官方更名记录核验"
    return label


def listing_direction(a_listing_date: str | None, h_listing_date: str | None) -> str:
    try:
        a_day = date.fromisoformat(a_listing_date or "")
        h_day = date.fromisoformat(h_listing_date or "")
    except ValueError:
        return "上市先后待核验"
    return "A→H" if a_day < h_day else "H→A" if h_day < a_day else "同期上市"


def build_a_to_h(
    listings: list[dict[str, Any]],
    active_apps: list[dict[str, Any]],
    a_shares: list[dict[str, Any]],
    seed: dict[str, Any],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], dict[str, int], list[dict[str, Any]]]:
    a_by_code = {item["a_code"]: item for item in a_shares if item.get("a_code")}
    listed_by_hk = {item["hk_code"]: item for item in listings}
    verified_listed = []
    verified_active = []
    rejected_listed: dict[str, dict[str, Any]] = {}
    stats = Counter()

    def eligible_listed(listing: dict[str, Any], official_a: dict[str, Any]) -> bool:
        direction = listing_direction(official_a.get("listing_date"), listing.get("listing_date"))
        identity = official_identity_check(listing["company_name"], official_a)
        if direction == "A→H" and identity in {"代码与公司名双重一致", "代码一致，名称近似", "官方更名记录核验"}:
            return True
        rejected_listed[listing["hk_code"]] = {
            "company_name": listing["company_name"], "hk_code": listing["hk_code"], "a_code": official_a["a_code"],
            "a_listing_date": official_a.get("listing_date"), "hk_listing_date": listing.get("listing_date"),
            "direction": direction, "name_cross_check": identity,
            "reason": direction if direction != "A→H" else identity,
            "a_official_url": official_a["official_url"],
            "hk_official_url": listing.get("original_document_url") or listing["source_url"],
        }
        return False

    for candidate in seed.get("listed_mappings", []):
        official_a = a_by_code.get(candidate["a_code"])
        official_h = listed_by_hk.get(candidate["hk_code"])
        if not official_a or not official_h:
            stats["seed_listed_unmatched"] += 1
            continue
        if not eligible_listed(official_h, official_a):
            continue
        verified_listed.append(
            {
                "status": "已上市",
                "company_name": official_h["company_name"],
                "a_code": official_a["a_code"],
                "a_exchange": official_a["exchange"],
                "a_short_name": official_a["short_name"],
                "a_industry": official_a.get("industry"),
                "a_official_url": official_a["official_url"],
                "a_listing_date": official_a.get("listing_date"),
                "a_name_evidence_url": OFFICIAL_NAME_ALIASES.get(official_a["a_code"], {}).get("source_url"),
                "hk_code": official_h["hk_code"],
                "hk_listing_date": official_h["listing_date"],
                "hk_offer_price": official_h["offer_price_hkd"],
                "hk_proceeds_hkd": official_h["total_proceeds_hkd"],
                "hk_listing_method": official_h.get("hk_listing_method") or official_h.get("ipo_classification") or "IPO",
                "is_fundraising_ipo": not official_h.get("excluded_from_ipo_statistics", False),
                "sponsors": official_h.get("sponsors", []),
                "hk_official_url": official_h.get("original_document_url") or official_h["source_url"],
                "hk_summary_url": official_h["source_url"],
                "verification": "HKEX stock code + Mainland exchange stock code",
                "name_cross_check": official_identity_check(official_h["company_name"], official_a),
                "source_grade": "A/A",
            }
        )
        stats["seed_listed_verified"] += 1

    known_pairs = {(item["hk_code"], item["a_code"]) for item in verified_listed}
    for listing in listings:
        if any(pair[0] == listing["hk_code"] for pair in known_pairs):
            continue
        official_a = match_a_share(listing["company_name"], a_shares)
        if official_a and eligible_listed(listing, official_a):
            verified_listed.append(
                {
                    "status": "已上市",
                    "company_name": listing["company_name"],
                    "a_code": official_a["a_code"],
                    "a_exchange": official_a["exchange"],
                    "a_short_name": official_a["short_name"],
                    "a_industry": official_a.get("industry"),
                    "a_official_url": official_a["official_url"],
                    "a_listing_date": official_a.get("listing_date"),
                    "a_name_evidence_url": OFFICIAL_NAME_ALIASES.get(official_a["a_code"], {}).get("source_url"),
                    "hk_code": listing["hk_code"],
                    "hk_listing_date": listing["listing_date"],
                    "hk_offer_price": listing["offer_price_hkd"],
                    "hk_proceeds_hkd": listing["total_proceeds_hkd"],
                    "hk_listing_method": listing.get("hk_listing_method") or listing.get("ipo_classification") or "IPO",
                    "is_fundraising_ipo": not listing.get("excluded_from_ipo_statistics", False),
                    "sponsors": listing.get("sponsors", []),
                    "hk_official_url": listing.get("original_document_url") or listing["source_url"],
                    "hk_summary_url": listing["source_url"],
                    "verification": "unique official-name match across HKEX and Mainland exchange",
                    "name_cross_check": official_identity_check(listing["company_name"], official_a),
                    "source_grade": "A/A",
                }
            )
            stats["auto_listed_verified"] += 1

    used_active: set[str] = set()
    for candidate in seed.get("pipeline_candidates", []):
        official_a = a_by_code.get(candidate["a_code"])
        app = match_application(candidate["company_name"], active_apps)
        if not official_a or not app or app["application_id"] in used_active:
            if official_a:
                stats["seed_pipeline_not_currently_active"] += 1
            continue
        identity = official_identity_check(app["company_name"], official_a)
        if identity not in {"代码与公司名双重一致", "代码一致，名称近似", "官方更名记录核验"}:
            stats["seed_pipeline_name_rejected"] += 1
            rejected_listed[f"app-{app['application_id']}-{official_a['a_code']}"] = {
                "company_name": app["company_name"], "application_id": app["application_id"],
                "hk_code": None, "a_code": official_a["a_code"],
                "a_official_name": official_a.get("full_name"),
                "a_listing_date": official_a.get("listing_date"), "hk_listing_date": None,
                "direction": "申请身份待核验", "name_cross_check": identity,
                "reason": "历史候选映射与两地官方公司名称不一致，不采纳此代码配对",
                "a_official_url": official_a["official_url"], "hk_official_url": preferred_application_document(app),
            }
            continue
        used_active.add(app["application_id"])
        verified_active.append(
            {
                "status": "有效申请-PHIP" if app["has_phip"] else "有效申请-AP",
                "company_name": app["company_name"],
                "a_code": official_a["a_code"],
                "a_exchange": official_a["exchange"],
                "a_short_name": official_a["short_name"],
                "a_industry": official_a.get("industry"),
                "a_official_url": official_a["official_url"],
                "a_listing_date": official_a.get("listing_date"),
                "application_id": app["application_id"],
                "hk_first_document_date": app["first_document_date"],
                "hk_latest_document_date": app["latest_document_date"],
                "hk_official_url": preferred_application_document(app),
                "sponsors": app.get("sponsors", []),
                "sponsor_source_url": app.get("sponsor_source_url"),
                "verification": "HKEX applicant name + Mainland exchange stock code",
                "name_cross_check": identity,
                "source_grade": "A/A",
            }
        )
        stats["seed_pipeline_verified"] += 1

    for app in active_apps:
        if app["application_id"] in used_active:
            continue
        official_a = match_a_share(app["company_name"], a_shares)
        if official_a:
            verified_active.append(
                {
                    "status": "有效申请-PHIP" if app["has_phip"] else "有效申请-AP",
                    "company_name": app["company_name"],
                    "a_code": official_a["a_code"],
                    "a_exchange": official_a["exchange"],
                    "a_short_name": official_a["short_name"],
                    "a_industry": official_a.get("industry"),
                    "a_official_url": official_a["official_url"],
                    "a_listing_date": official_a.get("listing_date"),
                    "application_id": app["application_id"],
                    "hk_first_document_date": app["first_document_date"],
                    "hk_latest_document_date": app["latest_document_date"],
                    "hk_official_url": preferred_application_document(app),
                    "sponsors": app.get("sponsors", []),
                    "sponsor_source_url": app.get("sponsor_source_url"),
                    "verification": "unique official-name match across HKEX and Mainland exchange",
                    "name_cross_check": official_identity_check(app["company_name"], official_a),
                    "source_grade": "A/A",
                }
            )
            stats["auto_pipeline_verified"] += 1
    verified_listed.sort(key=lambda item: item.get("hk_listing_date") or "", reverse=True)
    verified_active.sort(key=lambda item: item.get("hk_latest_document_date") or "", reverse=True)
    stats["listed_direction_or_identity_excluded"] = sum(bool(row.get("hk_code")) for row in rejected_listed.values())
    return verified_listed, verified_active, dict(stats), list(rejected_listed.values())


def year_summary(listings: list[dict[str, Any]], a_to_h: list[dict[str, Any]]) -> list[dict[str, Any]]:
    ah_by_year = Counter(
        (item.get("hk_listing_date") or "")[:4]
        for item in a_to_h
        if item.get("is_fundraising_ipo", True)
    )
    output = []
    for year in sorted({item["year"] for item in listings}, reverse=True):
        rows = [item for item in listings if item["year"] == year]
        total = sum(item["total_proceeds_hkd"] for item in rows)
        output.append(
            {
                "year": year,
                "ipo_count": len(rows),
                "proceeds_hkd": round(total, 2),
                "proceeds_hkd_bn": round(total / 1_000_000_000, 2),
                "a_to_h_count": ah_by_year[str(year)],
                "a_to_h_share_pct": round(ah_by_year[str(year)] / len(rows) * 100, 1) if rows else None,
                "source_as_of": max((item.get("source_as_of") or "" for item in rows), default=None),
            }
        )
    return output


def sponsor_listed_summary(listings: list[dict[str, Any]], current_year: int) -> list[dict[str, Any]]:
    projects: defaultdict[str, list[dict[str, Any]]] = defaultdict(list)
    for item in listings:
        for sponsor in item.get("sponsors", []):
            projects[sponsor].append({
                "hk_code": item["hk_code"],
                "company_name": item["company_name"],
                "listing_date": item.get("listing_date"),
                "year": item["year"],
                "market": item.get("market"),
                "proceeds_hkd": item.get("total_proceeds_hkd", 0),
                "proceeds_hkd_bn": round(item.get("total_proceeds_hkd", 0) / 1_000_000_000, 2),
                "source_url": item.get("original_document_url") or item.get("source_url"),
                "summary_source_url": item.get("source_url"),
                "source_label": "招股章程" if item.get("original_document_url") else "年度汇总表",
            })
    output = []
    for sponsor, items in projects.items():
        items.sort(key=lambda item: item.get("listing_date") or "", reverse=True)
        current = [item for item in items if item["year"] == current_year]
        output.append({
            "sponsor": sponsor,
            "current_year_ipo_count": len(current),
            "all_period_ipo_count": len(items),
            "current_year_attributed_proceeds_hkd": round(sum(item["proceeds_hkd"] for item in current), 2),
            "current_year_attributed_proceeds_hkd_bn": round(sum(item["proceeds_hkd"] for item in current) / 1_000_000_000, 2),
            "all_period_attributed_proceeds_hkd_bn": round(sum(item["proceeds_hkd"] for item in items) / 1_000_000_000, 2),
            "projects": items,
        })
    return sorted(
        output,
        key=lambda item: (
            item["current_year_attributed_proceeds_hkd"],
            item["current_year_ipo_count"],
            item["all_period_attributed_proceeds_hkd_bn"],
        ),
        reverse=True,
    )


def sponsor_application_summary(applications: list[dict[str, Any]]) -> list[dict[str, Any]]:
    projects: defaultdict[str, list[dict[str, Any]]] = defaultdict(list)
    for item in applications:
        for sponsor in item.get("sponsors", []):
            projects[sponsor].append({
                "application_id": item["application_id"],
                "company_name": item["company_name"],
                "market": item.get("market"),
                "stage": "PHIP" if item.get("has_phip") else "AP",
                "first_document_date": item.get("first_document_date"),
                "latest_document_date": item.get("latest_document_date"),
                "application_rounds": item.get("application_rounds"),
                "source_url": item.get("sponsor_source_url") or preferred_application_document(item),
            })
    output = []
    for sponsor, items in projects.items():
        items.sort(key=lambda item: item.get("latest_document_date") or "", reverse=True)
        output.append({
            "sponsor": sponsor,
            "active_project_count": len(items),
            "phip_count": sum(item["stage"] == "PHIP" for item in items),
            "projects": items,
        })
    return sorted(output, key=lambda item: (-item["active_project_count"], -item["phip_count"], item["sponsor"]))


def build_statistics(
    listings: list[dict[str, Any]],
    active_apps: list[dict[str, Any]],
    a_to_h_active: list[dict[str, Any]],
    current_year: int,
) -> dict[str, Any]:
    current = [item for item in listings if item["year"] == current_year]
    proceeds = [item.get("total_proceeds_hkd", 0) / 1_000_000_000 for item in current]
    ages = [item["application_age_days"] for item in active_apps if item.get("application_age_days") is not None]
    return {
        "listings": {
            "main_board_count": sum(item.get("market") == "主板" for item in current),
            "gem_count": sum(item.get("market") == "GEM" for item in current),
            "average_proceeds_hkd_bn": round(statistics.mean(proceeds), 2) if proceeds else None,
            "median_proceeds_hkd_bn": round(statistics.median(proceeds), 2) if proceeds else None,
            "deals_over_hkd_10bn": sum(value >= 10 for value in proceeds),
            "deals_hkd_1_to_10bn": sum(1 <= value < 10 for value in proceeds),
            "deals_under_hkd_1bn": sum(value < 1 for value in proceeds),
            "reporting_accountant_coverage_pct": round(sum(bool(item.get("reporting_accountant")) for item in current) / len(current) * 100, 1) if current else 0,
        },
        "applications": {
            "main_board_count": sum(item.get("market") == "主板" for item in active_apps),
            "gem_count": sum(item.get("market") == "GEM" for item in active_apps),
            "phip_count": sum(item.get("has_phip") for item in active_apps),
            "ap_count": sum(not item.get("has_phip") for item in active_apps),
            "multiple_round_count": sum((item.get("application_rounds") or 0) >= 2 for item in active_apps),
            "median_age_days": round(statistics.median(ages)) if ages else None,
            "sponsor_coverage_count": sum(bool(item.get("sponsors")) for item in active_apps),
        },
        "a_to_h_market_cap_bands": [
            {"band": band, "count": count}
            for band, count in Counter(item.get("a_market_cap_band") for item in a_to_h_active).most_common()
        ],
    }


def compare_previous(current: dict[str, Any], previous: dict[str, Any] | None) -> dict[str, Any]:
    if not previous:
        return {
            "baseline": True,
            "comparison_from": None,
            "comparison_to": current.get("snapshot_date"),
            "new_listings": [],
            "new_active_applications": [],
            "removed_active_applications": [],
        }
    if previous.get("snapshot_date") == current.get("snapshot_date"):
        same_day_changes = previous.get("weekly_changes") or {}
        if any(same_day_changes.get(key) for key in ("new_listings", "new_active_applications", "removed_active_applications")):
            return same_day_changes
        return {
            "baseline": True,
            "comparison_from": None,
            "comparison_to": current.get("snapshot_date"),
            "new_listings": [],
            "new_active_applications": [],
            "removed_active_applications": [],
        }
    previous_codes = {(item["year"], item["hk_code"]) for item in previous.get("listings", [])}
    current_apps = {item["application_id"]: item for item in current["active_applications"]}
    previous_apps = {item["application_id"]: item for item in previous.get("active_applications", [])}
    return {
        "baseline": False,
        "comparison_from": previous.get("snapshot_date"),
        "comparison_to": current.get("snapshot_date"),
        "new_listings": [item for item in current["listings"] if (item["year"], item["hk_code"]) not in previous_codes],
        "new_active_applications": [item for key, item in current_apps.items() if key not in previous_apps],
        "removed_active_applications": [item for key, item in previous_apps.items() if key not in current_apps],
    }


def calendar_week_activity(snapshot: dict[str, Any], listing_source_as_of: str) -> dict[str, Any]:
    cutoff = date.fromisoformat(snapshot["snapshot_date"])
    monday = cutoff - timedelta(days=cutoff.weekday() + 7)
    sunday = monday + timedelta(days=6)
    start, end = monday.isoformat(), sunday.isoformat()
    events: dict[tuple[str, str], dict[str, Any]] = {}
    for row in snapshot["application_history"] + snapshot["active_applications"]:
        for document in row.get("documents", []):
            day = document.get("date") or ""
            if start <= day <= end and re.search(r"申[請请]版本", document.get("document_type") or ""):
                key = (row["application_id"], day)
                events[key] = {
                    "application_id": row["application_id"], "company_name": row["company_name"],
                    "date": day, "source_url": document.get("full_document_url") or document.get("multi_file_url"),
                }
    applications = sorted(events.values(), key=lambda row: (row["date"], row["application_id"]), reverse=True)
    return {
        "period_start": start, "period_end": end,
        "listing_source_as_of": listing_source_as_of,
        "listing_coverage_complete": listing_source_as_of >= end,
        "listings": [row for row in snapshot["listings"] if start <= (row.get("listing_date") or "") <= end],
        "applications": applications,
        "application_company_count": len({normalize_company(row["company_name"]) for row in applications}),
    }


def write_json(path: Path, value: Any, *, compact: bool = False) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(value, ensure_ascii=False, indent=None if compact else 2, separators=(",", ":") if compact else None) + "\n",
        encoding="utf-8",
    )


def write_csv(path: Path, rows: list[dict[str, Any]], columns: list[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=columns, extrasaction="ignore")
        writer.writeheader()
        for row in rows:
            flattened = {}
            for key, value in row.items():
                if isinstance(value, list) and all(isinstance(item, str) for item in value):
                    flattened[key] = " / ".join(value)
                elif isinstance(value, (list, dict)):
                    flattened[key] = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
                else:
                    flattened[key] = value
            writer.writerow(flattened)


def rebuild_research_outputs(full_snapshot, dashboard, universe, intelligence, as_of):
    from pipeline_watch import build_watch, write_outputs
    pipeline_watch = build_watch(full_snapshot, universe, intelligence, as_of)
    full_snapshot["pipeline_watch"] = pipeline_watch
    research_ids = {i for row in pipeline_watch["rows"] if row["status"] == "public_active" for i in row["active_application_ids"]}
    research_apps = [r for r in full_snapshot["active_applications"] if str(r["application_id"]) in research_ids]
    research_ah = [r for r in full_snapshot["a_to_h_active"] if str(r["application_id"]) in research_ids]
    conflicts = [r for r in pipeline_watch["resolved"] if r.get("active_application_ids")]
    excluded_ids = {i for r in conflicts for i in r["active_application_ids"]}
    assert research_ids | excluded_ids == {str(r["application_id"]) for r in full_snapshot["active_applications"]}, "Raw/research active sets do not reconcile"
    assert not research_ids & excluded_ids, "Conflicting active classification"
    for target in (full_snapshot, dashboard):
        target["research_active_applications"] = research_apps
        target["research_a_to_h_active"] = research_ah
        target["active_state_conflicts"] = conflicts
    write_csv(PUBLIC_DATA / "research_active_applications.csv", research_apps,
              ["application_id", "company_name", "market", "status", "first_document_date", "latest_document_date", "has_phip", "application_rounds", "document_count", "application_age_days", "sponsors", "sponsor_source_url", "warning_url"])
    write_outputs(pipeline_watch, archive=False)
    return pipeline_watch


def retain_prior_application_history(history, active, previous, snapshot_date):
    """Keep dated filing evidence when a refreshed public index drops an ID.

    Absence from today's active index establishes neither lapse nor termination.
    Retained former active rows therefore have an explicitly unknown current status.
    """
    present = {str(r['application_id']) for r in history + active}
    retained = []
    if not previous or previous.get('snapshot_date', '9999') >= snapshot_date:
        return history
    former = {str(r['application_id']): r for r in previous.get('application_history', [])}
    former.update({str(r['application_id']): r for r in previous.get('active_applications', [])})
    for app_id, row in former.items():
        if app_id in present or row.get('latest_document_date', '9999') > snapshot_date:
            continue
        row = dict(row)
        row.setdefault('history_retained_source_date', previous['snapshot_date'])
        row['history_last_observed_status'] = row.get('history_last_observed_status') or row.get('status')
        row['history_retained_reason'] = '本期公开索引未列该ID，保留已保存的历史文件证据；当前状态待核实'
        if row.get('status_code') == 'A':
            row.update(status_code='U', status='当前状态待核实（历史申请记录保留）')
        retained.append(row)
    return history + retained


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--excel-seed", type=Path, help="Optional one-time historic A/H mapping workbook")
    parser.add_argument("--snapshot-date", default=os.environ.get("HKIPO_SNAPSHOT_DATE"))
    parser.add_argument("--sse-manual-json", type=Path, default=os.environ.get("HKIPO_SSE_MANUAL_JSON"))
    parser.add_argument("--start-year", type=int, default=2021)
    parser.add_argument("--end-year", type=int, default=datetime.now(HK_TZ).year)
    arguments = parser.parse_args()
    for directory in (RAW, PROCESSED, REFERENCE, SNAPSHOTS, PUBLIC_DATA):
        directory.mkdir(parents=True, exist_ok=True)

    fetcher = Fetcher()
    generated_at = datetime.now(HK_TZ).isoformat(timespec="seconds")
    snapshot_day = date.fromisoformat(arguments.snapshot_date) if arguments.snapshot_date else datetime.now(HK_TZ).date()
    if snapshot_day > datetime.now(HK_TZ).date():
        raise ValueError(f"Snapshot date cannot be in the future: {snapshot_day}")
    snapshot_date = snapshot_day.isoformat()
    manual_sse_path = arguments.sse_manual_json
    if manual_sse_path and not manual_sse_path.is_absolute():
        manual_sse_path = ROOT / manual_sse_path
    reuse_verified_szse = os.environ.get("HKIPO_REUSE_VERIFIED_SZSE") == "1"

    official_processing_statistics = fetch_hkex_ipo_processing_statistics(fetcher, snapshot_day)
    fetcher.save(HKEX_NLR_PAGE, "hkex/new-listing-main-board.html", source="HKEXnews")
    listings: list[dict[str, Any]] = []
    nlr_as_of: dict[int, str | None] = {}
    for year in range(arguments.start_year, arguments.end_year + 1):
        url = HKEX_NLR_TEMPLATE.format(year=year)
        payload = fetcher.save(url, f"hkex/nlr/{year}.xlsx", source="HKEXnews")
        records, as_of = parse_nlr(payload, year, url)
        listings.extend(records)
        nlr_as_of[year] = as_of

        gem_filename = gem_report_filename(year)
        gem_url = HKEX_GEM_BASE.format(filename=gem_filename)
        gem_payload = fetcher.save(gem_url, f"hkex/nlr-gem/{year}-{gem_filename}", source="HKEXnews")
        gem_records, gem_as_of = parse_gem_report(gem_payload, year, gem_url)
        listings.extend(gem_records)
        nlr_as_of[f"gem_{year}"] = gem_as_of
    listings = [
        item for item in listings
        if not item.get("listing_date") or item["listing_date"] <= snapshot_date
    ]

    current_sets: dict[str, list[dict[str, Any]]] = {}
    for board_token, board_label in (("sehk", "主板"), ("gem", "GEM")):
        for stem in ("appactive_app", "appactive_appphip", "appinactive", "applisted", "appreturned"):
            name = f"{stem}_{board_token}_c"
            url = HKEX_APP_JSON.format(name=name)
            payload = fetcher.save(url, f"hkex/apps/{name}.json", source="HKEXnews")
            parsed = json.loads(payload.decode("utf-8-sig"))
            current_sets[name] = [normalize_application(item, board=board_label) for item in parsed.get("app", []) if item.get("id")]

    live_listing_as_of, live_listing_gap_fills = fill_verified_nlr_gaps(
        fetcher, listings, current_sets, snapshot_day, nlr_as_of.get(arguments.end_year), SNAPSHOTS
    )

    active_by_id: dict[str, dict[str, Any]] = {}
    for name in ("appactive_app_sehk_c", "appactive_appphip_sehk_c", "appactive_app_gem_c", "appactive_appphip_gem_c"):
        for item in current_sets[name]:
            item = application_as_of(item, snapshot_day)
            if not item:
                continue
            existing = active_by_id.get(item["application_id"])
            if not existing or len(item["documents"]) > len(existing["documents"]):
                active_by_id[item["application_id"]] = item
    active_apps = list(active_by_id.values())
    active_apps.sort(key=lambda item: item.get("latest_document_date") or "", reverse=True)
    active_index_components = {
        "main_board_ap": sum(
            application_as_of(item, snapshot_day) is not None
            for item in current_sets["appactive_app_sehk_c"]
        ),
        "main_board_phip": sum(
            application_as_of(item, snapshot_day) is not None
            for item in current_sets["appactive_appphip_sehk_c"]
        ),
        "gem_ap": sum(
            application_as_of(item, snapshot_day) is not None
            for item in current_sets["appactive_app_gem_c"]
        ),
        "gem_phip": sum(
            application_as_of(item, snapshot_day) is not None
            for item in current_sets["appactive_appphip_gem_c"]
        ),
    }
    active_index_rows = sum(active_index_components.values())
    active_company_groups: defaultdict[str, list[dict[str, str]]] = defaultdict(list)
    for item in active_apps:
        active_company_groups[normalize_company(item["company_name"])].append({
            "application_id": item["application_id"],
            "company_name": item["company_name"],
        })
    duplicate_company_groups = [
        {
            "company_name": records[0]["company_name"],
            "application_ids": [record["application_id"] for record in records],
        }
        for records in active_company_groups.values()
        if len(records) > 1
    ]
    active_application_scope = {
        "label": "HKEXnews官方当前AP/PHIP申请记录",
        "counting_rule": "合并主板及GEM的当前AP与PHIP官方索引，并按申请ID去重；同一公司不同申请ID分别保留，不包含失效、撤回、退回、被拒或已上市记录。",
        "source_url": "https://www1.hkexnews.hk/app/appindex.html?lang=zh",
        "official_index_rows": active_index_rows,
        "unique_application_records": len(active_apps),
        "unique_company_names": len(active_company_groups),
        "duplicate_company_name_groups": len(duplicate_company_groups),
        "duplicate_company_records": duplicate_company_groups,
        "duplicate_application_ids_removed": active_index_rows - len(active_apps),
        "components": active_index_components,
    }
    simplify_records(listings, ("company_name", "reporting_accountant", "property_valuer", "industry", "listing_method"))
    simplify_list_field(listings, "sponsors")
    for listing in listings:
        corrected_date = KNOWN_PROSPECTUS_DATE_CORRECTIONS.get((int(listing["year"]), listing["hk_code"]))
        if corrected_date:
            listing["prospectus_date_reported"] = listing.get("prospectus_date")
            listing["prospectus_date"] = corrected_date
            listing["prospectus_date_correction_source"] = "HKEXnews final prospectus"
    enrich_listing_original_documents(fetcher, listings)
    listings, excluded_non_ipo_listings = split_ipo_and_non_ipo_listings(listings)
    simplify_records(active_apps, ("company_name", "status"))
    enrich_application_sponsors(fetcher, active_apps)
    simplify_list_field(active_apps, "sponsors")

    application_history = []
    for year in range(arguments.start_year, arguments.end_year + 1):
        for board_token, board_label in (("sehk", "主板"), ("gem", "GEM")):
            name = f"app_{year}_{board_token}_c"
            url = HKEX_APP_JSON.format(name=name)
            payload = fetcher.save(url, f"hkex/apps/{name}.json", source="HKEXnews")
            parsed = json.loads(payload.decode("utf-8-sig"))
            for item in parsed.get("app", []):
                if not item.get("id"):
                    continue
                observation = application_as_of(normalize_application(item, year, board_label), snapshot_day)
                if observation:
                    application_history.append(observation)
    simplify_records(application_history, ("company_name", "status"))
    prior_paths = sorted((p for p in SNAPSHOTS.glob('????-??-??*.json') if p.name[:10] < snapshot_date), key=lambda p: json.loads(p.read_text(encoding='utf-8')).get('generated_at', ''), reverse=True)
    prior = json.loads(prior_paths[0].read_text(encoding='utf-8')) if prior_paths else None
    application_history = retain_prior_application_history(application_history, active_apps, prior, snapshot_date)

    seed_path = REFERENCE / "excel_seed.json"
    if arguments.excel_seed:
        if not arguments.excel_seed.exists():
            raise FileNotFoundError(arguments.excel_seed)
        seed = parse_excel_seed(arguments.excel_seed)
        write_json(seed_path, seed)
    elif seed_path.exists():
        seed = json.loads(seed_path.read_text(encoding="utf-8"))
    else:
        seed = {"listed_mappings": [], "pipeline_candidates": [], "role": "no Excel seed supplied"}
    simplify_records(seed.get("listed_mappings", []), ("company_name",))
    simplify_records(seed.get("pipeline_candidates", []), ("company_name",))

    a_shares = fetch_sse(fetcher, manual_sse_path, snapshot_date) + fetch_szse(
        fetcher,
        snapshot_date if reuse_verified_szse else None,
    )
    write_json(PROCESSED / "a_share_official_universe.json", {"generated_at": generated_at, "records": a_shares})
    all_hk_listing_events = listings + excluded_non_ipo_listings
    a_to_h_listed, a_to_h_active, verification_stats, a_to_h_exclusions = build_a_to_h(all_hk_listing_events, active_apps, a_shares, seed)
    required_a_codes = {item["a_code"] for item in a_to_h_listed + a_to_h_active if item.get("a_code")}
    a_market = fetch_a_share_market_data(
        fetcher,
        a_shares,
        required_a_codes,
        snapshot_day,
        reuse_sse_cache=bool(manual_sse_path),
        reuse_szse_cache=reuse_verified_szse,
    )
    apply_a_share_model(a_to_h_listed, a_market)
    apply_a_share_model(a_to_h_active, a_market)
    sse_market_dates = sorted({
        item.get("market_data_date")
        for item in a_to_h_listed + a_to_h_active
        if item.get("a_exchange") == "SSE" and item.get("market_data_date")
    })

    limitations = [
        "首日涨跌幅不在新上市报告字段内，当前快照不以第三方行情补值。",
        "基石投资者需逐份招股书解析，当前完整快照先保留官方申请文件元数据与链接。",
        "北交所页面的反自动化重定向导致本次未纳入其全量股票清单；相关记录会标记待补证，不会推测。",
        "A→H 预测发行规模为情景模型，不是发行人、保荐人或交易所预测；默认 H/A 折价35.7%、发行比例10%、绿鞋15%。",
        "港交所主板新上市报告中的介绍上市、GEM转板、De-SPAC继承公司及其他零募资事件保留在审计清单，但不计入IPO家数、募资额、A→H IPO占比或保荐人排名。",
        (
            "港交所月报“审核处理中申请”是监管处理宗数，HKEXnews“当前AP/PHIP记录”是公开文件索引按申请ID去重后的"
            "逐记录名单；两者的日期、覆盖类别、状态和计数单位不同，不能以差额推算未公开申请人数量。"
        ),
    ]
    original_document_count = sum(bool(item.get("original_document_url")) for item in listings)
    if original_document_count < len(listings):
        pending_documents = len(listings) - original_document_count
        limitations.append(
            f"{original_document_count}/{len(listings)}条IPO记录已直达港交所披露易公司级最终上市文件；"
            f"另有{pending_documents}条最终文件直链待核验，不能因此断言官方文件不公开。"
            "每条记录均保留年度新上市报告作为统计依据，不以非官方链接补值。"
        )
    current_nlr_as_of = nlr_as_of.get(arguments.end_year)
    listing_source_as_of = max(current_nlr_as_of or "", live_listing_as_of or "")
    active_application_as_of = max(
        (item.get("latest_document_date") or "" for item in active_apps),
        default=None,
    )
    if current_nlr_as_of and current_nlr_as_of < snapshot_date:
        limitations.append(
            f"本快照截止{snapshot_date}；港交所当前发布的{arguments.end_year}年新上市报告自身截止"
            f"{current_nlr_as_of}；另用港交所实盘新上市名录和公司级配发公告核验至"
            f"{listing_source_as_of}，不会将预定日期、ETF或债券计作IPO。"
        )
    if manual_sse_path:
        limitations.append(
            f"上交所证券名录采用未修改的官方导出文件并核验SHA-256，名录截止{snapshot_date}；"
            "上交所A股市值仅沿用各行已标注日期的最近一次成功官方收盘值，未以第三方行情或估算值冒充8月20日行情。"
        )
    if reuse_verified_szse:
        limitations.append(
            f"深交所证券名录文件沿用最近一次成功官方下载，并以深交所上市/终止上市公告核验至{snapshot_date}未发生名录变动；"
            "深市行情沿用各行已标注日期的最近一次成功官方收盘值。"
        )

    listings.sort(key=lambda item: (item.get("listing_date") or "", item["hk_code"]), reverse=True)
    application_history.sort(key=lambda item: item.get("latest_document_date") or "", reverse=True)
    year_stats = year_summary(listings, a_to_h_listed)
    listed_sponsor_stats = sponsor_listed_summary(listings, arguments.end_year)
    application_sponsor_stats = sponsor_application_summary(active_apps)
    statistics_summary = build_statistics(listings, active_apps, a_to_h_active, arguments.end_year)

    full_snapshot = {
        "schema_version": "2.2.0",
        "generated_at": generated_at,
        "snapshot_date": snapshot_date,
        "timezone": "Asia/Hong_Kong",
        "production_sources": ["HKEXnews", "HKEX", "SSE", "SZSE"],
        "excel_dependency": False,
        "excel_role": seed.get("role"),
        "coverage": {
            "start_year": arguments.start_year,
            "end_year": arguments.end_year,
            "listing_records": len(listings),
            "non_ipo_listing_records_excluded": len(excluded_non_ipo_listings),
            "application_history_records": len(application_history),
            "active_application_records": len(active_apps),
            "a_share_official_records": len(a_shares),
            "a_to_h_listed_verified": len(a_to_h_listed),
            "a_to_h_active_verified": len(a_to_h_active),
        },
        "nlr_as_of": nlr_as_of,
        "active_application_scope": active_application_scope,
        "official_processing_statistics": official_processing_statistics,
        "year_summary": year_stats,
        "statistics": statistics_summary,
        "sponsor_listed_summary": listed_sponsor_stats,
        "sponsor_application_summary": application_sponsor_stats,
        "listings": listings,
        "excluded_non_ipo_listings": excluded_non_ipo_listings,
        "active_applications": active_apps,
        "application_history": application_history,
        "a_to_h_listed": a_to_h_listed,
        "a_to_h_active": a_to_h_active,
        "a_to_h_exclusions": a_to_h_exclusions,
        "verification_stats": verification_stats,
        "quality": {
            "official_listing_rows_with_code": sum(bool(item.get("hk_code")) for item in listings),
            "official_listing_rows_with_proceeds": sum(item.get("total_proceeds_hkd", 0) > 0 for item in listings),
            "official_listing_rows_with_original_prospectus": sum(bool(item.get("original_document_url")) for item in listings),
            "official_listing_original_prospectus_coverage_pct": round(
                sum(bool(item.get("original_document_url")) for item in listings) / len(listings) * 100,
                1,
            ) if listings else 0,
            "official_listing_documents_pending": len(listings) - original_document_count,
            "active_app_rows_with_official_documents": sum(bool(item.get("documents")) for item in active_apps),
            "source_freshness": {
                "snapshot_date": snapshot_date,
                "hkex_new_listing_report_as_of": current_nlr_as_of,
                "hkex_newly_listed_securities_as_of": live_listing_as_of,
                "verified_post_nlr_listing_codes": live_listing_gap_fills,
                "listing_continuity": fetcher.listing_continuity,
                "hkex_active_applications_as_of": active_application_as_of,
                "sse_universe_as_of": snapshot_date if manual_sse_path else None,
                "sse_universe_mode": "manual-official-export" if manual_sse_path else "official-api",
                "sse_market_min_date": sse_market_dates[0] if sse_market_dates else None,
                "sse_market_max_date": sse_market_dates[-1] if sse_market_dates else None,
                "szse_universe_mode": "reused-verified-no-change" if reuse_verified_szse else "official-api",
                "szse_change_control_verified_through": snapshot_date if reuse_verified_szse else None,
            },
            "limitations": limitations,
        },
        "sources": fetcher.manifest,
    }

    previous = None
    previous_paths = sorted(
        (
            path for path in SNAPSHOTS.glob("????-??-??*.json")
            if path.name[:10] < snapshot_date
        ),
        key=lambda path: path.stem,
        reverse=True,
    )
    if previous_paths:
        try:
            previous = json.loads(previous_paths[0].read_text(encoding="utf-8"))
        except Exception:
            previous = None
    changes = compare_previous(full_snapshot, previous)
    full_snapshot["weekly_changes"] = changes
    full_snapshot["weekly_activity"] = calendar_week_activity(full_snapshot, listing_source_as_of)

    dashboard = {
        "schema_version": full_snapshot["schema_version"],
        "generated_at": generated_at,
        "snapshot_date": snapshot_date,
        "coverage": full_snapshot["coverage"],
        "year_summary": year_stats,
        "statistics": statistics_summary,
        "active_application_scope": active_application_scope,
        "official_processing_statistics": official_processing_statistics,
        "excluded_non_ipo_listings": excluded_non_ipo_listings,
        "current_year": next((item for item in year_stats if item["year"] == arguments.end_year), None),
        "active_application_count": len(active_apps),
        "active_phip_count": sum(item["has_phip"] for item in active_apps),
        "yearly_application_counts": [
            {"year": year, "count": sum(item.get("observed_year") == year for item in application_history)}
            for year in range(arguments.start_year, arguments.end_year + 1)
        ],
        "listings": listings,
        "latest_listings": [item for item in listings if item["year"] == arguments.end_year],
        "active_applications": active_apps,
        "a_to_h_listed": a_to_h_listed,
        "a_to_h_active": a_to_h_active,
        "a_to_h_exclusions": a_to_h_exclusions,
        "sponsor_listed_summary": listed_sponsor_stats,
        "sponsor_application_summary": application_sponsor_stats,
        "model_assumptions": {
            "ha_discount_pct": MODEL_HA_DISCOUNT_PCT,
            "issue_ratio_pct": MODEL_ISSUE_RATIO_PCT,
            "greenshoe_pct": MODEL_GREENSHOE_PCT,
            "label": "情景测算，非官方预测",
        },
        "weekly_changes": changes,
        "weekly_activity": full_snapshot["weekly_activity"],
        "quality": full_snapshot["quality"],
        "official_sources": [
            {"label": "HKEX IPO申请月度处理报告", "url": official_processing_statistics[0]["source_url"]},
            {"label": "HKEX 新上市报告", "url": HKEX_NLR_PAGE},
            {"label": "HKEXnews 申请版本及 PHIP", "url": "https://www1.hkexnews.hk/app/appindex.html?lang=zh"},
            {"label": "上交所股票列表", "url": SSE_REFERER},
            {"label": "深交所股票列表", "url": SZSE_REFERER},
            {"label": "中国证监会境外发行上市备案", "url": CSRC_FILING_PAGE},
        ],
    }

    intelligence = json.loads((REFERENCE / "pipeline_intelligence.json").read_text(encoding="utf-8"))
    rebuild_research_outputs(full_snapshot, dashboard, {"records": a_shares}, intelligence, snapshot_date)
    write_json(PROCESSED / "full_snapshot.json", full_snapshot)
    write_json(PROCESSED / "dashboard.json", dashboard)
    write_json(DATA / "raw_manifest.json", {"generated_at": generated_at, "documents": fetcher.manifest})
    write_json(PUBLIC_DATA / "dashboard.json", dashboard, compact=True)
    write_json(PUBLIC_DATA / "full_snapshot.json", full_snapshot, compact=True)
    write_csv(
        PUBLIC_DATA / "listed_ipos.csv",
        listings,
        ["year", "hk_code", "company_name", "ipo_classification", "prospectus_date", "listing_date", "offer_price_hkd", "total_proceeds_hkd", "sponsors", "original_document_status", "original_document_url", "original_document_unavailable_reason", "source_url"],
    )
    write_csv(
        PUBLIC_DATA / "active_applications.csv",
        active_apps,
        ["application_id", "company_name", "market", "status", "first_document_date", "latest_document_date", "has_phip", "application_rounds", "document_count", "application_age_days", "sponsors", "sponsor_source_url", "warning_url"],
    )
    write_csv(
        PUBLIC_DATA / "excluded_non_ipo_listings.csv",
        excluded_non_ipo_listings,
        ["year", "hk_code", "company_name", "prospectus_date", "listing_date", "ipo_classification", "exclusion_reason", "original_document_url", "source_url"],
    )
    write_csv(
        PUBLIC_DATA / "a_to_h.csv",
        a_to_h_listed + full_snapshot["research_a_to_h_active"],
        ["status", "company_name", "a_code", "a_exchange", "a_short_name", "a_industry", "a_market_cap_rmb_bn", "a_market_cap_band", "hk_code", "application_id", "hk_listing_date", "hk_listing_method", "is_fundraising_ipo", "hk_first_document_date", "hk_latest_document_date", "hk_proceeds_hkd", "estimated_h_valuation_rmb_bn", "estimated_base_issue_rmb_bn", "estimated_max_issue_rmb_bn", "sponsors", "verification", "name_cross_check", "a_official_url", "hk_official_url"],
    )
    print(json.dumps({"ok": True, **full_snapshot["coverage"], "year_summary": year_stats[:2]}, ensure_ascii=False, indent=2))
    write_csv(PUBLIC_DATA / "a_to_h_exclusions.csv", a_to_h_exclusions,
              ["company_name", "hk_code", "application_id", "a_code", "a_official_name", "a_listing_date", "hk_listing_date", "direction", "reason", "a_official_url", "hk_official_url"])
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"HKEX pipeline failed: {error}", file=sys.stderr)
        raise
