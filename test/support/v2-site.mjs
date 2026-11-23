import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CHAIN_ID, deploy, startChain } from "../../.launchpad/checks/round-1/chain.mjs";
import { compile, compileEntry } from "../../.launchpad/checks/round-1/compile.mjs";

export const root = fileURLToPath(new URL("../../", import.meta.url));
export const ALLOCATION = 1_000_000n * 10n ** 18n;
export const QUOTE = 123_456_789n;
export const DAY = 86_400;
export const actors = Object.fromEntries(["deployer", "seller", "buyer", "other", "treasury"]
  .map((name, index) => [name, `0x${String(index + 1).repeat(40)}`]));
const MIME = { html: "text/html", css: "text/css", js: "text/javascript", json: "application/json" };

let artifacts;

export async function v2World() {
  artifacts ??= {
    legacy: compileEntry(),
    deals: compile(root, "contracts/OtcDealsV2.sol").OtcDealsV2,
    token: compile(join(root, ".launchpad/checks"), "round-2/FixtureToken.sol").FixtureToken,
  };
  const { deployer, seller, buyer, treasury } = actors;
  const chain = await startChain(Object.values(actors));
  const legacy = await deploy(chain, deployer, artifacts.legacy);
  const deals = await deploy(chain, deployer, artifacts.deals, [treasury]);
  const deploymentBlock = Number(await chain.rpc("eth_blockNumber"));
  const base = await deploy(chain, deployer, artifacts.token, ["ALFA", 18]);
  const quote = await deploy(chain, deployer, artifacts.token, ["USDC", 6]);
  await base.as(deployer).mint(seller, 4n * ALLOCATION);
  await quote.as(deployer).mint(buyer, 5n * QUOTE);
  return {
    chain, deals, base, quote,
    route: (id) => `#/v2/d/${CHAIN_ID}/${deals.address.toLowerCase()}/${id}`,
    config: { chainId: CHAIN_ID, contract: legacy.address, v2Contract: deals.address, v2DeploymentBlock: deploymentBlock, rpcUrl: "/rpc" },
  };
}

export async function serveV2(world, { demo = false, port = 0, directory = resolve(root, "web") } = {}) {
  const server = createServer(async (req, res) => {
    const reply = (status, type, body) => res.writeHead(status, { "content-type": type, "cache-control": "no-store" }).end(body);
    try {
      const url = new URL(req.url, "http://127.0.0.1");
      if (req.method === "POST" && ["/rpc", "/wallet"].includes(url.pathname)) {
        let raw = "";
        for await (const chunk of req) {
          raw += chunk;
          if (raw.length > 10_000) return reply(413, "text/plain", "Request too large");
        }
        const request = JSON.parse(raw);
        if (url.pathname === "/rpc") return reply(200, MIME.json, JSON.stringify(await world.chain.publicRpc(request)));
        const account = ["seller", "buyer", "other"].includes(request.role) && actors[request.role];
        const origin = `http://127.0.0.1:${server.address().port}`;
        if (!demo || req.headers.origin !== origin || !account || request.tx?.from !== account) {
          return reply(403, MIME.json, JSON.stringify({ error: "This demo wallet accepts only local fixture transactions." }));
        }
        const { to, data } = request.tx;
        const hash = await world.chain.submit(account, { to, data });
        return reply(200, MIME.json, JSON.stringify({ result: hash }));
      }
      if (req.method !== "GET") return reply(405, "text/plain", "Method unavailable");
      if (url.pathname === "/config.json") return reply(200, MIME.json, JSON.stringify(world.config));
      if (url.pathname === "/demo-wallet.js" && demo) return reply(200, MIME.js, demoWallet());
      if (url.pathname === "/fixture.json" && demo) {
        return reply(200, MIME.json, JSON.stringify({ seller: actors.seller, buyer: actors.buyer, allocationToken: world.base.address, paymentToken: world.quote.address }));
      }
      const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
      if (!/^[a-z0-9-]+\.(html|js|css)$/.test(file)) return reply(404, "text/plain", "File unavailable");
      let body = await readFile(join(directory, file), "utf8");
      if (file === "index.html" && demo) body = body.replace("</head>", '<script src="/demo-wallet.js"></script></head>');
      reply(200, MIME[file.split(".").at(-1)], body);
    } catch (error) {
      reply(400, MIME.json, JSON.stringify({ error: error.message }));
    }
  });
  await new Promise((success, failure) => server.once("error", failure).listen(port, "127.0.0.1", success));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((done) => {
      server.closeAllConnections();
      server.close(done);
    }),
  };
}

function demoWallet() {
  return `(() => {
    const role = new URLSearchParams(location.search).get("wallet");
    const actors = ${JSON.stringify({ seller: actors.seller, buyer: actors.buyer, other: actors.other })};
    if (!["seller", "buyer", "other"].includes(role)) return;
    const from = actors[role];
    window.ethereum = {
      async request({method, params}) {
        if (method === "eth_accounts") return sessionStorage.getItem("demo:" + role) ? [from] : [];
        if (method === "eth_requestAccounts") {
          if (!confirm("Connect the simulated " + role + " wallet?")) throw Object.assign(new Error("Declined"), {code:4001});
          sessionStorage.setItem("demo:" + role, "1");
          return [from];
        }
        if (method === "eth_chainId") return "${`0x${CHAIN_ID.toString(16)}`}";
        if (method !== "eth_sendTransaction") throw new Error("This demo only supports local test transactions.");
        if (!confirm("Send this simulated transaction from " + role + "?")) throw Object.assign(new Error("Declined"), {code:4001});
        const reply = await fetch("/wallet", {method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify({role, tx:params[0]})});
        const result = await reply.json();
        if (result.error) throw new Error(result.error);
        return result.result;
      }
    };
    addEventListener("DOMContentLoaded", () => {
      const badge = document.createElement("span");
      badge.className = "chip";
      badge.textContent = "Demo " + role;
      document.querySelector(".top").append(badge);
    });
  })();`;
}
