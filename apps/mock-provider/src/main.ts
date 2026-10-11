import { serve } from "@hono/node-server";
import { createMockApp } from "./app.js";

const port = Number(process.env.PORT ?? 8788);

serve({ fetch: createMockApp().fetch, port }, (info) => {
  console.log(`mock provider listening on http://localhost:${info.port}`);
});
