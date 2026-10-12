import dashboard from '@/data/processed/dashboard.json';
import { applicationCompanyKey } from './application-groups';

export const verifiedApplicationLabel = '核验后公开申请';

export function applicationScopeNote(onlyAh=false) {
  const raw=onlyAh?dashboard.a_to_h_active:dashboard.active_applications;
  const research=onlyAh?dashboard.research_a_to_h_active:dashboard.research_active_applications;
  const rawKeys=new Set(raw.map(r=>applicationCompanyKey(r.company_name)));
  const keptKeys=new Set(research.map(r=>applicationCompanyKey(r.company_name)));
  const excluded=[...rawKeys].filter(k=>!keptKeys.has(k)).length;
  return `原始${rawKeys.size}家，剔除已上市／明确终止${excluded}家`;
}

export function displayApplicationStatus(row:{status:string;status_label:string}) {
  return row.status==='public_active'?verifiedApplicationLabel:row.status_label;
}
