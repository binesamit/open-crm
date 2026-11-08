-- How each sign-in session was made: an account may require Google / Microsoft sign-in.
ALTER TABLE "auth_sessions" ADD COLUMN "sign_in_method" varchar(32);
