// Test mask password + readline xen kẽ TRƯỚC khi bootstrap thật.
// Verify: mask hiện '*', Enter kết thúc, Ctrl-C thoát sạch, readline sau OK.

import passwordPrompt from "@inquirer/password";
import inputPrompt from "@inquirer/input";

async function ask(q: string): Promise<string> {
  return (await inputPrompt({ message: q })).trim();
}

async function askPassword(q: string): Promise<string> {
  return (await passwordPrompt({ message: q, mask: "*" })).trim();
}

async function main() {
  console.log("=== Test mask + readline xen kẽ ===\n");

  const email = await ask("Test 1 — nhập email (readline thường): ");
  console.log(`  Got email: ${email}\n`);

  try {
    const pw = await askPassword("Test 2 — nhập password (mask, gõ backspace + Enter): ");
    console.log(`  Got password length: ${pw.length} (không log giá trị)\n`);
  } catch (e) {
    console.log(`  Got: ${(e as Error).message}\n`);
    rl.close();
    process.exit(0);
  }

  const after = await ask("Test 3 — readline sau mask có chạy được không? Gõ gì đó: ");
  console.log(`  Got: ${after}\n`);

  console.log("✓ Mask + input xen kẽ OK.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
