CREATE TABLE `password_reset_tokens` (
	`email` text PRIMARY KEY NOT NULL,
	`token` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `personal_access_tokens` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`tokenable_type` text NOT NULL,
	`tokenable_id` text NOT NULL,
	`name` text NOT NULL,
	`token` text NOT NULL,
	`abilities` text NOT NULL,
	`last_used_at` integer,
	`expires_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `personal_access_tokens_token_unique` ON `personal_access_tokens` (`token`);--> statement-breakpoint
CREATE INDEX `personal_access_tokens_tokenable_index` ON `personal_access_tokens` (`tokenable_type`,`tokenable_id`);--> statement-breakpoint
ALTER TABLE `users` ADD `email_verified_at` integer;