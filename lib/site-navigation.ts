export const pageIds=['home','ipo','applications','ah','sponsors','methodology'] as const;
export type SitePage=typeof pageIds[number];
export function readRoute(hash:string) {
  const [page,params='']=hash.replace(/^#/,'').split('?');
  const query=new URLSearchParams(params);
  return {tab:pageIds.includes(page as SitePage)?page as SitePage:'home' as SitePage,q:query.get('q')||'',section:query.get('section')||''};
}
export function routeHash(tab:SitePage,q='',section='') {
  const params=new URLSearchParams();if(q)params.set('q',q);if(section)params.set('section',section);
  return `#${tab}${params.size?'?'+params.toString():''}`;
}
export function subscribeRoute(callback:()=>void) {window.addEventListener('hashchange',callback);return ()=>window.removeEventListener('hashchange',callback);}
export const currentRoute=()=>window.location.hash;
export const serverRoute=()=>'';
