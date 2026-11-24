import { h, show } from "./ui.js";
import { BrokerChain, brokerError } from "./v3-protocol.js";
import { brokerDealPage } from "./v3-deal.js";
import { brokerHistoryPage } from "./v3-history.js";
import { newBrokerPage } from "./v3-new.js";
import { header, message, panel, shell } from "./v3-view.js";

let copy;
export function brokerPage(app, hash) {
  const duplicate = (record) => { copy = record; location.hash = "#/v3/new"; };
  try {
    if (!app.hasV3) throw new Error("This site needs a BrokerDeals deployment in config.json to open version 3 links.");
    const protocol = new BrokerChain(app.chain, app.config);
    if (hash === "#/v3/new") {
      const original = copy;
      copy = null;
      return newBrokerPage(app, protocol, original);
    }
    copy = null;
    if (hash === "#/v3/deals") return brokerHistoryPage(app, protocol, duplicate);
    const id = /^#\/v3\/d\/(0x[0-9a-f]{64})$/i.exec(hash)?.[1];
    const payload = /^#\/v3\/p\/(.*)$/.exec(hash)?.[1];
    if (id || payload) return brokerDealPage(app, protocol, { id, payload, duplicate });
    throw new Error("Open the full deal link shared by your broker, or prepare a new proposal.");
  } catch (error) {
    const text = error.code ? brokerError(error) : error.message;
    show(app.main, shell("deal", header("Broker deal unavailable", ""), panel(message(text, true),
      h("a", { href: "#/", class: "button secondary" }, "Back to otc.fam"))));
    return { update() {}, stop() {} };
  }
}
