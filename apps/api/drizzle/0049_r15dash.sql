-- Round 15: a board view of type `dashboard` (dashboard widgets scoped to the board, kept in the view's settings).
ALTER TYPE "public"."view_type" ADD VALUE IF NOT EXISTS 'dashboard';
