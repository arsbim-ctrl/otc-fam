// npm run deploy, end to end: a local chain (the checks' EDR) served over HTTP, a fresh random key that it funds,
// then the script. It must print only the new contract's address on stdout, and that contract must answer getDeal.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { test } from "node:test";
import { promisify } from "node:util";
import { Wallet } from "ethers";
import { startChain } from "../.launchpad/checks/round-1/chain.mjs";

const run = promisify(execFile);

test("npm run deploy deploys OtcDeals from DEPLOYER_KEY to RPC_URL and prints its address", async () => {
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
    const env = { ...process.env, RPC_URL: `http://127.0.0.1:${server.address().port}`, DEPLOYER_KEY: deployer.privateKey };
    const { stdout, stderr } = await run(process.execPath, ["scripts/deploy.mjs"], { env });
    const address = stdout.trim();
    assert.match(address, /^0x[0-9a-fA-F]{40}$/, `stdout is only the address; it was ${JSON.stringify(stdout)}`);
    assert.ok(!stderr.includes(deployer.privateKey.slice(2)), "the key is never printed");
    assert.notEqual(await chain.rpc("eth_getCode", [address, "latest"]), "0x", "there is a contract at the printed address");
    const unknown = await chain.rpc("eth_call", [{ to: address, data: `0x82fd5bac${"0".repeat(63)}1` }, "latest"]); // getDeal(1)
    assert.equal(BigInt(`0x${unknown.slice(2 + 7 * 64)}`), 0n, "getDeal(1) on the new contract has status None");
  } finally {
    server.close();
  }
});

test("npm run deploy refuses to start without RPC_URL and DEPLOYER_KEY, or with a malformed key", async () => {
  const fails = (env) => run(process.execPath, ["scripts/deploy.mjs"], { env: { PATH: process.env.PATH, ...env } }).then(() => assert.fail("it exited 0"), (e) => e);
  assert.match((await fails({})).stderr, /RPC_URL=.*DEPLOYER_KEY=/);
  const malformed = await fails({ RPC_URL: "http://127.0.0.1:9", DEPLOYER_KEY: "not-a-key-but-a-secret" });
  assert.match(malformed.stderr, /not a private key/);
  assert.ok(!malformed.stderr.includes("not-a-key-but-a-secret"), "the value given as a key is not printed back");
});
