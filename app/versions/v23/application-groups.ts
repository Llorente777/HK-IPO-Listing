// Company-level display; keep every original application ID as evidence.
export function applicationCompanyKey(name: string) {
  return name.normalize("NFKC").toLowerCase()
    .replace(/\s*\((?:前称为?|前稱為?|曾用名|formerly).*\)\s*$/, "")
    .replace(/\s*[-—–]\s*(?:h\s*股|[bpswz]{1,3})\s*$/, "")
    .replace(/[\s()（）,，.。·•\-—–]/g, "");
}

export function groupApplications<T extends {company_name: string; application_id: string; latest_document_date: string | null}>(rows: T[]) {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const key = applicationCompanyKey(row.company_name);
    groups.set(key, [...(groups.get(key) || []), row]);
  }
  return [...groups.entries()].map(([id, records]) => {
    records.sort((a, b) => (b.latest_document_date || "").localeCompare(a.latest_document_date || "") || b.application_id.localeCompare(a.application_id));
    return {id, latest: records[0], records};
  }).sort((a, b) => (b.latest.latest_document_date || "").localeCompare(a.latest.latest_document_date || "") || a.id.localeCompare(b.id));
}
