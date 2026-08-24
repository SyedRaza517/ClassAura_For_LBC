-- Button colours, set separately from the primary brand colour.
--
-- Additive and nullable, so an institution that has set nothing is unaffected: the
-- resolver falls back to the primary colour and to a luminance-chosen text colour,
-- which is what happened before these columns existed.
--
-- They exist because deriving a button from the header colour does not work. A colour
-- chosen to read well as a wide band is often wrong as a small solid control — a pale
-- brand colour produces a button nobody can see, and a very dark one swallows its own
-- label. That is a legible palette producing an illegible interface, and no amount of
-- deriving fixes it; the college has to be able to say.

ALTER TABLE "TenantBranding" ADD COLUMN "buttonColor" TEXT;
ALTER TABLE "TenantBranding" ADD COLUMN "buttonTextColor" TEXT;
