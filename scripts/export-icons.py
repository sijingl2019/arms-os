"""Export existing icon artwork to OS formats. Requires Pillow and Playwright.
Run: python scripts/export-icons.py (the source artwork lives in assets/icons).
"""
from pathlib import Path
from io import BytesIO
from PIL import Image
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
ICONS = ROOT / 'assets/icons'
app_icon = Image.open(ICONS / 'app-icon.png').convert('RGBA')
app_icon.save(ICONS / 'app-icon.ico', sizes=[(n,n) for n in (16,20,24,32,40,48,64,128,256)])
svg = (ICONS / 'tray.svg').read_text(encoding='utf-8')
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={'width':64,'height':64},device_scale_factor=1)
    for name,color in [('dark','#202630'),('light','#ffffff')]:
        artwork = svg.replace('#202630',color).replace('width="32" height="32" viewBox', 'width="64" height="64" viewBox')
        page.set_content('<style>html,body{margin:0;background:transparent}svg{display:block}</style>'+artwork)
        png = page.locator('svg').screenshot(omit_background=True)
        image = Image.open(BytesIO(png)).convert('RGBA')
        image.resize((32,32),Image.Resampling.LANCZOS).save(ICONS / f'tray-{name}.png')
        image.save(ICONS / f'tray-{name}.ico',sizes=[(n,n) for n in (16,20,24,32,40,48,64)])
    browser.close()
print('Exported taskbar ICO and light/dark tray PNG + ICO assets.')
