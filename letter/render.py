"""Снимает фон письма letter/bg.html в letter/bg-a4.jpg (A4, 1588×2246 px).

Запуск: python3 letter/render.py   (нужны playwright и Chrome)
"""
import pathlib, sys
from playwright.sync_api import sync_playwright
from PIL import Image

here = pathlib.Path(__file__).resolve().parent
chrome = sys.argv[1] if len(sys.argv) > 1 else "/usr/bin/google-chrome"

with sync_playwright() as p:
    b = p.chromium.launch(executable_path=chrome, args=["--no-sandbox", "--allow-file-access-from-files"])
    pg = b.new_page(viewport={"width": 794, "height": 1123}, device_scale_factor=2)
    pg.goto((here / "bg.html").as_uri())
    pg.evaluate("document.fonts.ready")
    pg.wait_for_timeout(600)
    pg.screenshot(path=str(here / "bg-a4.png"))
    b.close()

im = Image.open(here / "bg-a4.png").convert("RGB")
im.save(here / "bg-a4.jpg", quality=86, optimize=True, progressive=True, subsampling="4:2:0")
(here / "bg-a4.png").unlink()
print("bg-a4.jpg", im.size, (here / "bg-a4.jpg").stat().st_size // 1024, "КБ")
