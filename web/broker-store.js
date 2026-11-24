// One storage item per digest so tabs saving different links cannot overwrite one another.
import { digest, pack, unpack } from "./broker-terms.js";
import { same } from "./eth.js";

const prefix = (domain) => `otc:v3:${domain.chainId}:${domain.verifyingContract}:`;
export function rememberDeal(domain, terms, stage) {
  const key = prefix(domain) + digest(domain, terms);
  try {
    const old = JSON.parse(localStorage.getItem(key));
    if (old?.stage === "shared" || old?.stage === "created" && stage === "seen") return true;
    localStorage.setItem(key, JSON.stringify({ link: pack(domain, terms), stage }));
    return true;
  } catch { return false; }
}

export function localDeals(domain, account) {
  const saved = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key?.startsWith(prefix(domain))) continue;
      try {
        const { link, stage } = JSON.parse(localStorage.getItem(key));
        const { terms, domain: savedDomain } = unpack(link);
        const id = digest(savedDomain, terms);
        if (key === prefix(domain) + id && [terms.broker, terms.seller, terms.buyer].some((owner) => same(owner, account))) {
          saved.push({ id, terms, stage });
        }
      } catch {} // Ignore an unreadable local entry.
    }
  } catch {}
  return saved;
}
