// Tiny per-chunk FI/EN guesser. Used only to pick a TTS language hint for
// engines that need one (Kokoro/Chatterbox). VoxCPM2 needs no tag.
const FI_WORDS = new Set(('ja on ei se että mutta kun niin tämä tuo minä sinä hän me te he olen olet ' +
  'voit voin kanssa myös vain sitten nyt jos mikä mitä miten miksi kuin vielä joo kyllä okei hei moi ' +
  'tässä siinä tänään huomenna eli koska vaikka ole oli ovat sinun minun meidän teidän').split(' '));
const EN_WORDS = new Set(('the a an and is are was were it this that you i we they to of in on for with ' +
  'not but so if what how why can will would could should do does have has be been just now here there').split(' '));

export function guessLang(text, fallback = 'en') {
  const words = text.toLowerCase().match(/[\p{L}']+/gu) || [];
  if (!words.length) return fallback;
  let fi = 0, en = 0;
  for (const w of words) {
    if (FI_WORDS.has(w)) fi += 2;
    if (EN_WORDS.has(w)) en += 2;
    if (/[äöå]/.test(w)) fi += 2;
    if (/(ssa|ssä|sta|stä|lla|llä|lta|ltä|kin|kaan|kään|aa|ee|ii|oo|uu|yy)$/.test(w)) fi += 1;
    if (/(ing|tion|ed|ly|th)/.test(w)) en += 1;
  }
  if (fi === en) return fallback;
  return fi > en ? 'fi' : 'en';
}
