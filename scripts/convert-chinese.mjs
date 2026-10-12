import "./vendor/opencc.full.js";

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const input = JSON.parse(Buffer.concat(chunks).toString("utf8") || "[]");
const convert = globalThis.OpenCC.Converter({ from: "hk", to: "cn" });
process.stdout.write(JSON.stringify(input.map((value) => convert(String(value ?? "")))));
