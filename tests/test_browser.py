"""Render the actual card in Chromium using states captured from real HA."""

import asyncio
import json
from pathlib import Path

from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[1]


async def main():
    fixture = json.loads((ROOT / "tests/fixtures/ha-current.json").read_text())
    async with async_playwright() as pw:
        browser = await pw.chromium.launch()
        try:
            for width in (520, 360):
                page = await browser.new_page(viewport={"width": width, "height": 1200})
                await page.set_content("""<style>
                  body {margin:0; padding:12px; box-sizing:border-box; font:14px Arial;
                    --primary-color:#03a9f4; --primary-text-color:#222; --secondary-text-color:#666;
                    --divider-color:#ddd; --secondary-background-color:#eee;}
                  evolute-card {display:block;}
                </style>""")
                # HA's icon renderer is not needed for geometry or service tests.
                # Keep its normal 24px box while showing a symbol in screenshots.
                await page.add_script_tag(content="""
                  customElements.define('ha-icon', class extends HTMLElement {
                    connectedCallback() { this.style.cssText='display:inline-flex;width:24px;height:24px;align-items:center;justify-content:center';
                      this.textContent=this.getAttribute('icon')==='mdi:ev-plug-type2'?'🔌':'◇'; }
                  });
                  customElements.define('ha-card', class extends HTMLElement {
                    connectedCallback() {this.style.cssText='display:block;border:1px solid #ddd;border-radius:12px';}
                  });
                """)
                await page.add_script_tag(path=str(ROOT / "dist/evolute-card.js"))
                await page.evaluate("""hass => {
                  window.serviceCalls=[];
                  hass.callService=(...args)=>{serviceCalls.push(args);return new Promise(resolve=>window.finishService=resolve);};
                  window.hassData=hass;
                  window.card=document.createElement('evolute-card');
                  card.setConfig({}); document.body.append(card); card.hass=hass;
                  window.setState=(key,state,attrs={})=>{
                    const id=Object.values(hassData.entities).find(e=>e.translation_key===key).entity_id;
                    hassData.states[id]={...hassData.states[id],state,attributes:{...hassData.states[id]?.attributes,...attrs}};
                    card.hass=hassData;
                  };
                }""", fixture["snapshots"]["success"])
                assert "19°C / 92% / 101 км" in await page.locator('.barval[data-role="battery_pct"]').inner_text()
                assert await page.locator(".odo .plug").count() == 1
                assert await page.locator(".odo .dot").count() == 0
                assert await page.locator('[aria-current="step"]').inner_text() == "Выполнена"
                assert await page.evaluate("document.documentElement.scrollWidth <= innerWidth")
                battery = await page.locator('.barval[data-role="battery_pct"]').evaluate("el=>({scroll:el.scrollWidth,width:el.clientWidth})")
                assert battery["scroll"] <= battery["width"] + 1, battery
                out = ROOT / "artifacts" / str(width)
                out.mkdir(parents=True, exist_ok=True)
                await page.screenshot(path=str(out / "card.png"), full_page=True)
                await page.locator('button[data-role="lock"]').click()
                assert await page.locator('button[data-role="lock"]').is_disabled()
                assert await page.evaluate("serviceCalls.length") == 1
                assert await page.evaluate("serviceCalls[0][0] + '.' + serviceCalls[0][1]") == "lock.unlock"
                await page.evaluate("setState('central_lock','unlocking');setState('command_status','pending',{command:'centralLockingOff',command_id:'next'});")
                assert await page.locator('button[data-role="lock"]').inner_text() == "Открывается…"
                assert await page.locator('[aria-current="step"]').inner_text() == "Отправлена"
                await page.evaluate("setState('command_status','delivered')")
                assert await page.locator('[aria-current="step"]').inner_text() == "Доставлена"
                await page.screenshot(path=str(out / "delivered.png"), full_page=True)
                await page.evaluate("setState('central_lock','unlocked');setState('command_status','success');finishService();")
                await page.wait_for_function("!card._requestPending")
                assert await page.locator('button[data-role="lock"]').is_enabled()
                await page.evaluate("setState('charging_gun','off')")
                assert await page.locator(".odo .dot").count() == 1
                assert await page.locator(".odo .plug").count() == 0
                assert await page.evaluate("serviceCalls.length") == 1
                await page.close()
                print(f"Card at {width}px: layout, command progress and one service call verified")
        finally:
            await browser.close()


if __name__ == "__main__":
    asyncio.run(main())
