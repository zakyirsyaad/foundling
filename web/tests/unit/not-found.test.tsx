import { render, screen } from "@testing-library/react";

import { NotFoundView } from "@/features/landing/NotFoundView";

test("the 404 page says so in one heading and links back to the site and the app", () => {
  render(<NotFoundView />);
  expect(screen.getByRole("heading", { level: 1, name: "Page not found" })).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Go to the home page" })).toHaveAttribute("href", "/");
  expect(screen.getByRole("link", { name: "Open app" })).toHaveAttribute("href", "/app");
});
