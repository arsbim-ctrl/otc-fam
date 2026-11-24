// npm run deploy and npm run deploy:v2, end to end: a local chain (the checks' EDR) served over HTTP, a fresh random
// key that it funds, then the script. It must print only the new contract's address on stdout, and that contract must
// answer as the one it is.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import { test } from "node:test";
import { promisify } from "node:util";
import { Wallet } from "ethers";
import { CHAIN_ID, startChain } from "../.launchpad/checks/round-1/chain.mjs";

const run = promisify(execFile);
const TREASURY = "0x7ea5007ea5007ea5007ea5007ea5007ea5007ea5";

/** Runs `steps(chain, env)` with a local node at env.RPC_URL and a funded key in env.DEPLOYER_KEY. */
async function withNode(steps) {
  const deployer = Wallet.createRandom();
  const chain = await startChain([deployer.address]);
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    const answer = async (r) => {
      try {
        return { jsonrpc: "2.0", id: r.id, result: await chain.rpc(r.method, r.params) };
      } catch (e) {
        return { jsonrpc: "2.0", id: r.id, error: { code: e.code ?? -32000, message: e.message, data: e.data } };
      }
    };
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(Array.isArray(request) ? await Promise.all(request.map(answer)) : await answer(request)));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await steps(chain, { ...process.env, RPC_URL: `http://127.0.0.1:${server.address().port}`, DEPLOYER_KEY: deployer.privateKey });
  } finally {
    server.close();
  }
}

/** The address the script printed, after checking that it printed nothing else, never the key, and that a contract is there. */
async function deployed(chain, env, args = [], cwd) {
  const { stdout, stderr } = await run(process.execPath, [resolve("scripts/deploy.mjs"), ...args], { env, cwd });
  const address = stdout.trim();
  assert.match(address, /^0x[0-9a-fA-F]{40}$/, `stdout is only the address; it was ${JSON.stringify(stdout)}`);
  assert.ok(!stderr.includes(env.DEPLOYER_KEY.slice(2)), "the key is never printed");
  assert.ok(!stderr.includes(env.RPC_URL), "the RPC URL is never printed");
  assert.notEqual(await chain.rpc("eth_getCode", [address, "latest"]), "0x", "there is a contract at the printed address");
  return address;
}

test("npm run deploy deploys OtcDeals from DEPLOYER_KEY to RPC_URL and prints its address", () => withNode(async (chain, env) => {
  const address = await deployed(chain, env);
  const unknown = await chain.rpc("eth_call", [{ to: address, data: `0x82fd5bac${"0".repeat(63)}1` }, "latest"]); // getDeal(1)
  assert.equal(BigInt(`0x${unknown.slice(2 + 7 * 64)}`), 0n, "getDeal(1) on the new contract has status None");
}));

test("npm run deploy:v2 deploys OtcDealsV2 with the treasury in TREASURY, and says where its events start", () => withNode(async (chain, env) => {
  const address = await deployed(chain, { ...env, TREASURY }, ["v2"]);
  const treasury = await chain.rpc("eth_call", [{ to: address, data: "0x61d027b3" }, "latest"]); // treasury()
  assert.equal(`0x${treasury.slice(-40)}`, TREASURY);
  const { stderr } = await run(process.execPath, ["scripts/deploy.mjs", "v2"], { env: { ...env, TREASURY } });
  assert.match(stderr, /"contractV2": "0x[0-9a-fA-F]{40}", "fromBlockV2": \d+/);
}));

test("deploy:broker writes its actual deployment block and keeps the older deployments in config", () => withNode(async (chain, env) => {
  const cwd = mkdtempSync(resolve("node_modules/.broker-deploy-"));
  try {
    mkdirSync(join(cwd, "web"));
    symlinkSync(resolve("contracts"), join(cwd, "contracts"));
    const path = join(cwd, "web/config.json");
    const config = { chainId: CHAIN_ID, contract: TREASURY, contractV2: TREASURY, fromBlockV2: 1, rpcUrl: "rpc" };
    writeFileSync(path, JSON.stringify(config));
    const contractBroker = await deployed(chain, { ...env, TREASURY }, ["broker"], cwd);
    const fromBlockBroker = Number(await chain.rpc("eth_blockNumber"));
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { ...config, contractBroker, fromBlockBroker, treasuryBroker: TREASURY });
    assert.equal(await chain.rpc("eth_getCode", [contractBroker, `0x${(fromBlockBroker - 1).toString(16)}`]), "0x");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}));

test("npm run deploy refuses to start without RPC_URL and DEPLOYER_KEY, or with a malformed key", async () => {
  const fails = (env, args = []) => run(process.execPath, ["scripts/deploy.mjs", ...args], { env: { PATH: process.env.PATH, ...env } }).then(() => assert.fail("it exited 0"), (e) => e);
  assert.match((await fails({})).stderr, /RPC_URL=.*DEPLOYER_KEY=/);
  const malformed = await fails({ RPC_URL: "http://127.0.0.1:9", DEPLOYER_KEY: "not-a-key-but-a-secret" });
  assert.match(malformed.stderr, /not a private key/);
  assert.ok(!malformed.stderr.includes("not-a-key-but-a-secret"), "the value given as a key is not printed back");

  const key = Wallet.createRandom().privateKey;
  assert.match((await fails({ RPC_URL: "http://127.0.0.1:9", DEPLOYER_KEY: key }, ["v2"])).stderr, /TREASURY=.*npm run deploy:v2/, "v2 needs a treasury");
  for (const treasury of ["0x1234", `0x${"0".repeat(40)}`]) {
    assert.match((await fails({ RPC_URL: "http://127.0.0.1:9", DEPLOYER_KEY: key, TREASURY: treasury }, ["v2"])).stderr, /TREASURY is not an address that can receive the fees/);
  }
});
