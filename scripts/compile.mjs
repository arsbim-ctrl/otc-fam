import { readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import solc from 'solc';

export function compile() {
  const root = process.cwd();
  const read = (name) => {
    for (const dir of [root, resolve(root, 'node_modules')]) {
      const path = resolve(dir, name);
      if (!path.startsWith(dir + sep)) continue;
      try { return { contents: readFileSync(path, 'utf8') }; } catch { /* try package */ }
    }
    return { error: `Import not found: ${name}` };
  };
  const file = 'contracts/OtcDeals.sol';
  const output = JSON.parse(solc.compile(JSON.stringify({
    language: 'Solidity', sources: { [file]: { content: readFileSync(file, 'utf8') } },
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'cancun',
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } },
  }), { import: read }));
  const errors = (output.errors ?? []).filter(e => e.severity === 'error');
  if (errors.length) throw new Error(errors.map(e => e.formattedMessage).join('\n'));
  const c = output.contracts[file].OtcDeals;
  return { abi: c.abi, bytecode: '0x' + c.evm.bytecode.object };
}
