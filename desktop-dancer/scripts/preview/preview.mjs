// Dev: render a GLB/VRM to PNG (front, side, back).  node scripts/preview/preview.mjs model.glb out.png [--motion m.vrma --t 1.5] [--skeleton]
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const { chromium } = createRequire(import.meta.url)('playwright'); // preinstalled globally (NODE_PATH)

const args = process.argv.slice(2);
const opt = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);
const [model, out] = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--') && args[i - 1] !== '--skeleton'));
const browser = await chromium.launch({ args: ['--allow-file-access-from-files', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage();
page.on('console', (m) => m.type() === 'error' && console.error('[page]', m.text()));
await page.goto(new URL('./index.html', import.meta.url).href);
await page.waitForFunction(() => window.ready);
const res = await page.evaluate((o) => window.render(o), {
  model: readFileSync(model).toString('base64'),
  motion: opt('--motion') ? readFileSync(opt('--motion')).toString('base64') : undefined,
  t: Number(opt('--t') || 0),
  skeleton: args.includes('--skeleton'),
});
writeFileSync(out, Buffer.from(res.png.split(',')[1], 'base64'));
console.log('bbox', JSON.stringify(res.box.map((v) => v.map((x) => +x.toFixed(3)))));
await browser.close();
