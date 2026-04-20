import { describe, it, expect } from "vitest";
import { ALLOWED_LANGS, isAllowedLang } from "@/services/trophyLookup.service.js";

describe("isAllowedLang", () => {
  it("accetta tutte le lingue della whitelist (migration 017)", () => {
    for (const lang of ALLOWED_LANGS) {
      expect(isAllowedLang(lang)).toBe(true);
    }
  });

  it("rigetta lingue non whitelistate (anti-SQL-injection su nome colonna)", () => {
    expect(isAllowedLang("xx")).toBe(false);
    expect(isAllowedLang("")).toBe(false);
    expect(isAllowedLang("en; DROP TABLE trophies")).toBe(false);
    expect(isAllowedLang("EN")).toBe(false); // case-sensitive: solo lowercase
    expect(isAllowedLang("it_IT")).toBe(false);
  });

  it("whitelist include en + it (le lingue con indice trigram migration 024)", () => {
    expect(ALLOWED_LANGS).toContain("en");
    expect(ALLOWED_LANGS).toContain("it");
  });
});
