-- A second factor for the platform-operator login.
--
-- This is the highest-privilege login in the product: an operator can read, suspend
-- and delete every customer's data. It had a rate limiter but no second factor, while
-- an ordinary college lecturer could already enrol an authenticator — the protection
-- was strongest where the stakes were lowest.
--
-- Additive and OFF by default, so applying this signs nobody out and changes no
-- behaviour until an operator enrols. Enrolment is deliberately self-service rather
-- than forced here: forcing it in a migration would lock out an operator who has no
-- authenticator to hand, and locking out the platform tier needs database access to
-- undo.

ALTER TABLE "PlatformAdmin" ADD COLUMN "totpSecret" TEXT;
ALTER TABLE "PlatformAdmin" ADD COLUMN "totpEnabled" BOOLEAN NOT NULL DEFAULT false;
