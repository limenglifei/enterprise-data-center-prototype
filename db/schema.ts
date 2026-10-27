import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// Migrations create this table before serving requests; route handlers never DDL.
export const prototypeState = sqliteTable("prototype_state", {
  id: text("id").primaryKey(),
  revision: integer("revision").notNull().default(0),
  payload: text("payload").notNull(),
  updatedAt: text("updated_at").notNull(),
});
