import { describe, expect, it } from "vitest";
import { toLittleText } from "./linkedin-posts";

// LinkedIn "little text" (design §17): reserved characters escaped, hashtags kept clickable.
describe("toLittleText", () => {
  it("escapes the reserved characters so nothing after them is dropped", () => {
    expect(toLittleText("AI (really) @scale <3 *bold* _x_ ~y~ [z] {w} a|b \\")).toBe(
      "AI \\(really\\) \\@scale \\<3 \\*bold\\* \\_x\\_ \\~y\\~ \\[z\\] \\{w\\} a\\|b \\\\",
    );
  });

  it("turns hashtags into hashtag templates, Arabic included", () => {
    expect(toLittleText("Ship it #AI #تقنية now")).toBe("Ship it {hashtag|\\#|AI} {hashtag|\\#|تقنية} now");
    expect(toLittleText("#dev_tools")).toBe("{hashtag|\\#|dev\\_tools}");
  });

  it("leaves plain text alone", () => {
    expect(toLittleText("Plain sentence, with punctuation: yes.")).toBe("Plain sentence, with punctuation: yes.");
  });
});
