// A page whose prose is mostly in an image's caption: stripNonProse drops
// the figure, so extractArticle falls back to the unstripped page
// ("much_shorter"). For the tests of the fallback's log line, with markers
// that must never appear in it.
export const STRIP_FALLBACK_TITLE = "FALLBACK_TITLE Kelp forests";
export const STRIP_FALLBACK_TEXT_MARKER = "FALLBACK_TEXT_MARKER";

const caption =
  `${STRIP_FALLBACK_TEXT_MARKER} Kelp grows up to half a meter a day in cold, clear water near the coast. ` +
  "Fish hide among its fronds, and otters wrap themselves in it to sleep without drifting away. ";

export const STRIP_FALLBACK_HTML = `<html><head><title>${STRIP_FALLBACK_TITLE}</title></head><body><article>
<p>Kelp forests grow along rocky coasts where the water is cold and full of nutrients. They shelter many animals and need sunlight to grow, so they live in shallow water near the shore. Storms can tear them loose, but they grow back fast.
<figure><img src="kelp.jpg" alt=""><figcaption>${caption.repeat(3)}</figcaption></figure>
</article></body></html>`;
