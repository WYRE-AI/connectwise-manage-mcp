import { z } from "zod";

export const customFieldConditionsSchema = z.string().optional().describe(
  'Filter on custom fields (ConnectWise customFieldConditions query param, sent alongside conditions). Match a field by caption and value, e.g. caption="Contract Type" AND value="Managed". Strings in double quotes, dates in [brackets], value != null for any value.',
);
