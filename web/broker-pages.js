import { BrokerChain } from "./broker.js";
import { brokerBuilder } from "./broker-builder.js";
import { brokerDealPage } from "./broker-deal-page.js";
import { brokerHistory } from "./broker-history.js";
import { digest, unpack } from "./broker-terms.js";
import { brokerNav, errorText, heading } from "./broker-ui.js";
import { same } from "./eth.js";
import { card, h, notice } from "./ui.js";

const idle = () => ({ update() {}, stop() {} });

export function brokerPage(app, hash) {
  if (!app.hasBroker) {
    app.main.replaceChildren(h("div", { class: "broker-view" }, brokerNav(), heading("Broker deals unavailable",
      "This site needs a BrokerDeals deployment in config.json.")));
    return idle();
  }
  const api = app.brokerChain ??= new BrokerChain(app.chain, app.config);
  const route = /^#\/v3\/(d|new)\/(0x[^/]+)(?:\/([^/]+))?$/.exec(hash);
  if (route?.[1] === "d") return brokerDealPage(app, api, route[2].toLowerCase(), route[3]);
  if (hash === "#/v3/history") return brokerHistory(app, api);
  if (route?.[1] === "new") {
    try {
      const { domain, terms } = unpack(route[3] ?? "");
      if (domain.chainId !== api.domain.chainId || !same(domain.verifyingContract, api.contract) || digest(domain, terms) !== route[2]) {
        throw new Error("This copy does not match its origin. Go back to the original deal and duplicate it again.");
      }
      return brokerBuilder(app, api, terms);
    } catch (e) {
      app.main.replaceChildren(h("div", { class: "broker-view" }, brokerNav(), heading("Terms unavailable", "Open the original deal to duplicate it."),
        card(notice({ kind: "error", text: errorText(e) }))));
      return idle();
    }
  }
  if (hash === "#/v3/new" || hash === "#/v3/") return brokerBuilder(app, api);
  app.main.replaceChildren(h("div", { class: "broker-view" }, brokerNav(), heading("Broker deal link unavailable",
    "Open the complete link from the broker, or find an existing deal in Deal history.")));
  return idle();
}
