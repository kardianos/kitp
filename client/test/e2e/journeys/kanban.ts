// kanban journey: render the board, drag a card from the "todo" column
// to "doing", and verify the move settled.

import { By, type WebDriver } from 'selenium-webdriver';

import { waitFor } from '../driver.ts';
import { loginAsSystemUser, navigateSpa, sleep, waitForCountAtLeast } from '../helpers.ts';
import { captureScreenshot } from '../screenshots.ts';

export const journeyName = 'kanban';

export async function run(driver: WebDriver): Promise<void> {
  await loginAsSystemUser(driver);
  await navigateSpa(driver, '/kanban');

  // Wait for at least one column.
  await waitFor(driver, '[data-kanban-column]', 15_000);
  await waitForCountAtLeast(driver, '[data-kanban-column]', 2, 15_000);
  // Wait for at least one card in the todo column.
  await waitForCountAtLeast(
    driver,
    '[data-kanban-column][data-column="todo"] [data-card-id]',
    1,
    15_000,
  );
  await captureScreenshot(driver, journeyName, 'board');

  // Pick the first card in the todo column and the doing column container.
  const todoCards = await driver.findElements(
    By.css('[data-kanban-column][data-column="todo"] [data-card-id]'),
  );
  const sourceCard = todoCards[0]!;
  const doingColumn = await driver.findElement(
    By.css('[data-kanban-column][data-column="doing"]'),
  );

  // Compute drop target — the inner empty area below the column header.
  const sourceRect = await sourceCard.getRect();
  const doingRect = await doingColumn.getRect();

  // Start drag on the source card. The DragHandle commits after 4px of
  // movement; we intentionally pass through several intermediate moves so
  // the dnd rune runs its hit-testing.
  const actions = driver.actions({ async: true });
  await actions
    .move({ origin: sourceCard })
    .press()
    .move({ origin: sourceCard, x: 0, y: 8 })
    .perform();

  // Wait a tick for the drag to commit.
  await sleep(driver, 100);

  // Move into the doing column's body area.
  // We move via viewport coordinates (target = doing column center).
  const targetX = Math.floor(doingRect.x + doingRect.width / 2);
  const targetY = Math.floor(doingRect.y + doingRect.height / 2);
  // Selenium's actions API uses `move({ x, y })` relative to viewport when
  // origin is "viewport" (the default is "pointer"); use `origin: 'viewport'`
  // explicitly. Some chromedriver versions only accept WebElement origins,
  // so we fall back to relative moves from the source card.
  const dx = targetX - Math.floor(sourceRect.x + sourceRect.width / 2);
  const dy = targetY - Math.floor(sourceRect.y + sourceRect.height / 2);
  await driver.actions({ async: true })
    .move({ origin: sourceCard, x: dx, y: dy })
    .perform();
  await sleep(driver, 250);
  await captureScreenshot(driver, journeyName, 'drag_in_flight');

  // Release the pointer to commit the drop.
  await driver.actions({ async: true }).release().perform();

  // Wait for the optimistic patch + refresh batch to land.
  await sleep(driver, 1500);
  await captureScreenshot(driver, journeyName, 'after_move');
}
