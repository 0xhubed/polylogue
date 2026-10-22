import { expect, test } from "@playwright/test";

test("replays a simulated run in every view, and the scrubber changes the counters", async ({ page }) => {
  await page.goto("/?sim=polylogue&seed=1");
  for (const id of ["team-graph", "swimlanes", "chat-feed", "blackboard", "counters", "scrubber"]) {
    await expect(page.getByTestId(id)).toBeVisible();
  }
  await expect(page.locator(".react-flow__node")).toHaveCount(4);
  const atEnd = await page.getByTestId("counter-tokens").textContent();
  expect(Number(atEnd!.replace(/,/g, ""))).toBeGreaterThan(0);
  await page.getByTestId("scrubber").focus();
  await page.keyboard.press("Home");
  await expect(page.getByTestId("counter-tokens")).toHaveText("0");
});

test("the scrubber reaches the end of the run, and Play restarts from the start", async ({ page }) => {
  await page.goto("/?sim=polylogue&seed=1");
  await expect(page.getByTestId("counters")).toContainText("solved");
  await page.getByTestId("scrubber").focus();
  await page.keyboard.press("Home");
  await expect(page.getByTestId("counters")).toContainText("running");
  await page.keyboard.press("End");
  await expect(page.getByTestId("counters")).toContainText("solved");
  await page.getByRole("button", { name: "Play" }).click();
  await expect(page.getByRole("button", { name: "Pause" })).toBeVisible();
  await expect(page.getByTestId("counters")).toContainText("solved", { timeout: 15_000 });
  await expect(page.getByRole("button", { name: "Play" })).toBeVisible();
});

test("each team-graph node shows its agent's tokens, and edges carry direction and count", async ({ page }) => {
  await page.goto("/?sim=polylogue&seed=1");
  await expect(page.locator(".react-flow__node").first()).toContainText(/[\d,]+ tok/);
  await expect(page.locator(".react-flow__edge-textwrapper, .edge-label").first()).toContainText(/a\d→a\d \d+/);
});

test("an unknown run shows 'Run not found' when the server answers 404", async ({ page }) => {
  await page.route("**/runs/does-not-exist", (route) =>
    route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "Run not found" }) }));
  await page.goto("/?run=does-not-exist");
  await expect(page.getByTestId("run-error")).toHaveText("Run not found: does-not-exist");
});

test("a server error shows 'Could not load run' instead of a blank page", async ({ page }) => {
  await page.route("**/runs/does-not-exist", (route) =>
    route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "boom" }) }));
  await page.goto("/?run=does-not-exist");
  await expect(page.getByTestId("run-error")).toContainText("Could not load run does-not-exist");
});
