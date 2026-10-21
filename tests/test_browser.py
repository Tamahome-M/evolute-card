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
                  window.moreInfoEvents=[];
                  hass.callService=(...args)=>{serviceCalls.push(args);return new Promise(resolve=>window.finishService=resolve);};
                  hass.devices['test-car'].serial_number='TESTVIN0123456789';
                  hass.devices['test-car'].name='Evolute i-SPACE';
                  window.hassData=hass;
                  window.card=document.createElement('evolute-card');
                  card.setConfig({}); document.body.append(card); card.hass=hass;
                  card.addEventListener('hass-more-info',e=>moreInfoEvents.push(e.detail.entityId));
                  window.setState=(key,state,attrs={})=>{
                    const id=Object.values(hassData.entities).find(e=>e.translation_key===key).entity_id;
                    hassData.states[id]={...hassData.states[id],state,attributes:{...hassData.states[id]?.attributes,...attrs}};
                    card.hass=hassData;
                  };
                }""", fixture["snapshots"]["success"])
                assert "19°C / 92% / 101 км" in await page.locator('.barval[data-role="battery_pct"]').inner_text()
                assert await page.locator(".odo .plug").count() == 1
                assert await page.locator(".odo .dot").count() == 0
                assert await page.locator(".signal > span").inner_text() == "61%"
                signal_box = await page.locator(".signal").bounding_box()
                status_box = await page.locator(".odo .plug").bounding_box()
                assert signal_box["x"] + signal_box["width"] <= status_box["x"]
                await page.locator(".signal").click()
                expected_signal = await page.evaluate("Object.values(hassData.entities).find(e=>e.translation_key==='signal_percent').entity_id")
                assert await page.evaluate("moreInfoEvents") == [expected_signal]
                for key in ("battery_temp", "battery_pct", "remains_mileage"):
                    await page.locator(f'.battery-values span[data-role="{key}"]').click()
                    expected = await page.evaluate(
                        "key=>Object.values(hassData.entities).find(e=>e.translation_key===key).entity_id", key,
                    )
                    assert await page.evaluate("moreInfoEvents.at(-1)") == expected
                assert await page.evaluate("moreInfoEvents.length") == 4
                assert await page.evaluate("serviceCalls.length") == 0
                await page.evaluate("setState('signal_percent','0')")
                assert await page.locator(".signal > span").inner_text() == "0%"
                await page.evaluate("setState('signal_percent','unavailable')")
                assert await page.locator(".signal > span").inner_text() == "—%"
                await page.evaluate("setState('signal_percent','61')")
                assert await page.locator('[aria-current="step"]').inner_text() == "Выполнена"
                assert await page.evaluate("document.documentElement.scrollWidth <= innerWidth")
                assert await page.locator(".head").evaluate("el=>el.scrollWidth<=el.clientWidth")
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
                assert await page.locator('button[data-role="lock"] span').inner_text() == "Открывается…"
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
                assert await page.locator('button[data-role="prepare"], details.prep').count() == 0
                # Click the actual mode buttons in both directions, including
                # their busy/receipt lifecycle. No vehicle request is made.
                for role, state_key in (("heating", "heating"), ("cooling", "cooling"), ("trip", "trip_preparation")):
                    prefix = "trip_prepare" if role == "trip" else role
                    await page.evaluate("setState('central_lock','locked')")
                    for value, direction in (("off", "on"), ("on", "off")):
                        await page.evaluate("([key,value])=>setState(key,value)", [state_key, value])
                        action = page.locator(f'button[data-role="{role}"]')
                        assert await action.is_enabled()
                        await action.click()
                        expected_id = await page.evaluate(
                            "key=>Object.values(hassData.entities).find(e=>e.translation_key===key).entity_id",
                            f"{prefix}_{direction}",
                        )
                        assert await page.evaluate("serviceCalls.at(-1)") == ["button", "press", {"entity_id": expected_id}]
                        assert await action.is_disabled()
                        await page.evaluate("setState('command_status','pending')")
                        assert await page.locator('[aria-current="step"]').inner_text() == "Отправлена"
                        await page.evaluate("([key,value])=>{setState(key,value);setState('command_status','success');finishService();}",
                                            [state_key, "on" if direction == "on" else "off"])
                        await page.wait_for_function("!card._requestPending")
                assert await page.evaluate("serviceCalls.length") == 7
                await page.screenshot(path=str(out / "climate.png"), full_page=True)
                await page.close()
                print(f"Card at {width}px: signal and battery histories, layout, receipts and controls verified")
        finally:
            await browser.close()


if __name__ == "__main__":
    asyncio.run(main())
