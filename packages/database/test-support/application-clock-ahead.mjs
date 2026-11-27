import process from "node:process";
import "./host-clock-ahead.mjs";

/** This host's clock half a second ahead of the database's, and the pilot's answer to that. */
process.env.PILOT_CLOCK_FROM_DATABASE = "1";
