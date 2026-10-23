import { createHmac } from "node:crypto";
import { expect, type Page } from "@playwright/test";

export function totp(secret: string, at = Date.now()) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const char of secret.replace(/=+$/, "")) bits += alphabet.indexOf(char).toString(2).padStart(5, "0");
  const key = Buffer.from(bits.match(/.{8}/g)?.map((byte) => parseInt(byte, 2)) ?? []);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const hmac = createHmac("sha1", key).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  return String((hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

export async function turnOnTwoStep(page: Page, password: string) {
  await expect(page.getByRole("heading", { name: "Turn on two-step sign-in" })).toBeVisible();
  await page.getByLabel("Your password").fill(password);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Scan this code" })).toBeVisible();
  const secret = ((await page.locator("code").textContent()) ?? "").trim();
  await page.getByLabel("6-digit code").fill(totp(secret));
  await page.getByRole("button", { name: "Turn on and continue" }).click();
  return secret;
}

export async function answerTwoStep(page: Page, secret: string) {
  await expect(page.getByRole("heading", { name: "Two-step sign-in" })).toBeVisible();
  await page.getByLabel("6-digit code").fill(totp(secret));
  await page.getByRole("button", { name: "Sign in" }).click();
}
