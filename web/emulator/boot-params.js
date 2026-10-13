// Deep-link boot parameters, shared by the standalone emulator page and the
// top-level page (which forwards them into the embedded workbench iframe):
//   ?firmware=<repository id | probe>  load firmware on startup
//   ?script=<saved UI script name>     run a saved script after that firmware loads
//   ?tool=<firmware|scripts|midi|inspect>  open a workbench tool tab
// Values are untrusted URL data. They only select among the fixed firmware
// repository, the bundled integration probe, validated saved scripts, and the
// workbench tabs; they never name a URL to fetch or carry script content.
export const BOOT_KEYS = ['firmware', 'script', 'tool'];
export const BOOT_TOOLS = ['firmware', 'scripts', 'midi', 'inspect'];
export const PROBE_FIRMWARE = 'probe';

export function parseBootParams(search) {
  const params = new URLSearchParams(search);
  const errors = [];
  const read = (key, limit, expected) => {
    const value = (params.get(key) || '').trim();
    if (value.length <= limit) return value;
    errors.push(`The link's ${key} parameter must be ${expected}`);
    return '';
  };
  const firmware = read('firmware', 40, `a firmware repository id or "${PROBE_FIRMWARE}"`);
  let script = read('script', 120, 'a UI script name of 120 characters or fewer');
  let tool = read('tool', 20, `one of ${BOOT_TOOLS.join(', ')}`);
  if (tool && !BOOT_TOOLS.includes(tool)) {
    errors.push(`The link's tool parameter must be one of ${BOOT_TOOLS.join(', ')}`);
    tool = '';
  }
  if (script && !firmware) {
    errors.push("The link's script parameter needs a firmware parameter naming the image to load first");
    script = '';
  }
  return { firmware, script, tool, errors };
}

// The query string the top-level page passes to the workbench iframe, keeping
// only the boot parameters so unrelated ones (workspace, trackers) stay out.
export function forwardedBootQuery(search) {
  const params = new URLSearchParams(search);
  const forwarded = new URLSearchParams();
  for (const key of BOOT_KEYS) if (params.has(key)) forwarded.set(key, params.get(key));
  return forwarded.size ? `?${forwarded}` : '';
}
