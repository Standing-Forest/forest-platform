/** ADR-019: UUIDv7 identifiers — time-ordered, index-friendly. */
import { v7 as uuidv7 } from "uuid";

export const newId = (): string => uuidv7();
