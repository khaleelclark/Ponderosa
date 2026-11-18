/** Only these browser routes accept an owner handle in the Project slot. */
export function browserRouteUsesOwnerHandle(route:string|undefined):boolean {
  return /^\/api\/projects\/:projectId\/(?:browser(?:[/-]|$)|local-browser(?:[/-]|$)|saved-browser-access(?:[/-]|$)|agents\/:agentId\/browser-(?:location|preference)$)/u.test(route??'');
}
