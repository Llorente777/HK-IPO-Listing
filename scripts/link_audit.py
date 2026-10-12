"""Bounded HTTP check of links actually exposed by the current company tables.
Successful HTTP does not prove that the file's contents match the company.
"""
import concurrent.futures
import argparse
import json
import time
import urllib.request
import urllib.error
from datetime import datetime
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--retry-transient',action='store_true')
    parser.add_argument('--recheck-reserve-sources',action='store_true',help='Recheck cached reserve sponsor/prospectus links after status changes')
    args=parser.parse_args()
    read=lambda p:json.loads((ROOT/p).read_text(encoding='utf-8'))
    d=read('data/processed/dashboard.json'); p=read('public/data/pipeline_analytics.json')
    urls=set()
    def add(u):
        if u and u.startswith('https://'): urls.add(u)
    def visit(value):
        if isinstance(value, dict):
            for key, item in value.items():
                if isinstance(item, str) and ('url' in key): add(item)
                elif isinstance(item, (dict,list)): visit(item)
        elif isinstance(value,list):
            for item in value: visit(item)
    # Include every source family shown in all six views, not just main-company links.
    for payload in [d,p,read('public/data/pipeline_watch.json')]: visit(payload)
    add('https://www.hkex.com.hk/News/Regulatory-Announcements/2026/260821news?sc_lang=en')
    add('https://www.hkex.com.hk/News/Regulatory-Announcements/2026/260724news?sc_lang=en')
    add('https://www1.hkexnews.hk/search/titlesearch.xhtml?lang=zh')
    def check(u):
        req=urllib.request.Request(u,headers={'User-Agent':'Mozilla/5.0 (compatible; IPO-source-verification/1.0)','Range':'bytes=0-1023'})
        try:
            try:
                res = urllib.request.urlopen(req,timeout=10)
            except urllib.error.HTTPError as error:
                if error.code != 416: raise
                # Some valid servers do not accept byte-range requests.
                res = urllib.request.urlopen(urllib.request.Request(u,headers={'User-Agent':'Mozilla/5.0'}),timeout=10)
            with res:
                sample=res.read(1024)
                pdf_expected='.pdf' in u.lower().split('?')[0]
                is_pdf=sample.startswith(b'%PDF-')
                state='reachable' if not pdf_expected or is_pdf else 'unexpected_content'
                return {'url':u,'status':state,'http':res.status,'final_url':res.url,'pdf_signature':is_pdf if pdf_expected else None}
        except Exception as e:
            code=getattr(e,'code',None)
            return {'url':u,'status':'restricted' if code in (401,403,429) else 'not_verified','http':code,'reason':str(e)[:180]}
    results=[]
    if args.retry_transient:
        previous=read('public/data/link_audit.json')
        old={r['url']:{**r,'checked_at':r.get('checked_at',previous['checked_at'])} for r in previous['rows']}
        retry={u for u in urls if u not in old or (old[u]['status']!='reachable' and old[u].get('http') is None)}
        if args.recheck_reserve_sources:
            retry.update(u for r in p['rows'] if r['category']=='reserve' for u in (r.get('sponsor_source_url'),r.get('prospectus_url')) if u and u in urls)
        results=[r for u,r in old.items() if u in urls and u not in retry]
        urls=retry
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        for completed,result in enumerate(pool.map(check,sorted(urls)),1):
            results.append({**result,'checked_at':datetime.now().isoformat(timespec='seconds')})
            if completed%100==0: print(f'Checked {completed}/{len(urls)}',flush=True)
    report={'checked_at':datetime.now().isoformat(timespec='seconds'),'scope':'六个主页面及底表披露的公司原文件、保荐项目、历史申请、终止记录、渠道目录、双源证据及行情链接；HTTP与PDF签名检查不代表逐页内容复核。各链接检查时间单列。','total':len(results),'reachable':sum(r['status']=='reachable' for r in results),'rows':sorted(results,key=lambda r:r['url'])}
    out=ROOT/'outputs/link-audit';out.mkdir(parents=True,exist_ok=True)
    (out/(report['checked_at'].replace(':','-')+'.json')).write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    (ROOT/'public/data/link_audit.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    (ROOT/'data/processed/link_audit.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps({k:v for k,v in report.items() if k!='rows'},ensure_ascii=False))
if __name__=='__main__':main()
