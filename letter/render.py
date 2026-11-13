"""Снимает фоны документов в JPG (A4, 1588×2246 px):
letter/bg.html → bg-a4.jpg (письмо), tags.html → tags-a4.jpg (бирки), blank.html → blank-a4.jpg (бланк письма Деду Морозу).

Запуск: python3 letter/render.py [путь к Chrome]   (нужны playwright и Chrome)
"""
import pathlib, sys
from playwright.sync_api import sync_playwright
from PIL import Image

here = pathlib.Path(__file__).resolve().parent
chrome = sys.argv[1] if len(sys.argv) > 1 else "/usr/bin/google-chrome"
pages = [("bg.html", "bg-a4.jpg"), ("tags.html", "tags-a4.jpg"), ("blank.html", "blank-a4.jpg")]

with sync_playwright() as p:
    b = p.chromium.launch(executable_path=chrome, args=["--no-sandbox", "--allow-file-access-from-files"])
    pg = b.new_page(viewport={"width": 794, "height": 1123}, device_scale_factor=2)
    for src, out in pages:
        pg.goto((here / src).as_uri())
        pg.evaluate("document.fonts.ready")
        pg.wait_for_timeout(600)
        png = here / (out + ".png")
        pg.screenshot(path=str(png))
        im = Image.open(png).convert("RGB")
        im.save(here / out, quality=86, optimize=True, progressive=True, subsampling="4:2:0")
        png.unlink()
        print(out, im.size, (here / out).stat().st_size // 1024, "КБ")
    b.close()
