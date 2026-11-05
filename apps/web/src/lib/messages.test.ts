import assert from "node:assert/strict";
import { test } from "node:test";
import { requestLocales } from "@/server/request-locale";
import { en } from "./i18n/en";
import { ptBR } from "./i18n/pt-BR";
import { defaultLocale, isLocale, localeOr, messages, serverLocale } from "./messages";

const settings = messages.settings;

test("without a request locale the panel uses the server default, English unless set", () => {
  delete process.env.UNDERSTUDY_LOCALE;
  assert.equal(serverLocale(), "en");
  assert.equal(settings.title, en.settings.title);
});

test("a section read at module load follows the locale of each request", async () => {
  const [inPortuguese, inEnglish] = await Promise.all([
    requestLocales.run("pt-BR", async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return settings.title;
    }),
    requestLocales.run("en", async () => settings.title),
  ]);
  assert.equal(inPortuguese, ptBR.settings.title);
  assert.equal(inEnglish, en.settings.title);
});

test("functions and nested sections resolve at the moment they are read", () => {
  const recipe = messages.recipe;
  assert.equal(requestLocales.run("pt-BR", () => recipe.subtitle("Lemon")), ptBR.recipe.subtitle("Lemon"));
  assert.equal(requestLocales.run("en", () => recipe.subtitle("Lemon")), en.recipe.subtitle("Lemon"));
});

test("a section can be spread, listed and serialized like the dictionary itself", () => {
  requestLocales.run("pt-BR", () => {
    assert.deepEqual(Object.keys(settings), Object.keys(ptBR.settings));
    assert.equal({ ...settings }.title, ptBR.settings.title);
    assert.equal(JSON.parse(JSON.stringify(messages.nav)).recipes, ptBR.nav.recipes);
    assert.equal("title" in settings, true);
  });
});

test("an unknown locale falls back to the server default", () => {
  assert.equal(requestLocales.run("xx", () => serverLocale()), "en");
  assert.equal(requestLocales.run("constructor", () => serverLocale()), "en");
  assert.equal(isLocale("toString"), false);
});

test("shared spaces without a language keep the server default, not the person's", () => {
  process.env.UNDERSTUDY_LOCALE = "pt-BR";
  try {
    assert.equal(defaultLocale(), "pt-BR");
    assert.equal(requestLocales.run("en", () => localeOr(null)), "pt-BR");
    assert.equal(requestLocales.run("en", () => serverLocale()), "en");
  } finally {
    delete process.env.UNDERSTUDY_LOCALE;
  }
});
