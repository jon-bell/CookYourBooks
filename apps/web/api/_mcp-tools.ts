// Tool catalog for the MCP surface. Kept in a separate module so the
// HTTP handler stays focused on transport concerns, and so unit tests
// can exercise the dispatch table without booting a web server.
//
// Each tool:
//   - has a `name` exposed to the AI client
//   - advertises a JSON-Schema `inputSchema` the client can use to
//     produce valid arguments
//   - invokes one `cli_*` Postgres RPC via `callRpc`, reshapes the
//     result as a compact JSON string, and returns it
//
// All tool RPCs are `security definer` + token-scoped, so there's no
// cross-user data access to worry about at this layer.

export interface RpcClient {
  /** Call a `cli_*` RPC. Throws on HTTP / Postgres error. */
  call<T = unknown>(fn: string, args: Record<string, unknown>): Promise<T>;
}

export interface Tool {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
  run(args: Record<string, unknown>, client: RpcClient): Promise<unknown>;
}

function s(arg: unknown, field: string): string {
  if (typeof arg !== 'string' || !arg.trim()) {
    throw new Error(`${field} is required and must be a non-empty string`);
  }
  return arg;
}

function opt<T>(arg: T | undefined): T | null {
  return arg === undefined ? (null as unknown as T) : arg;
}

export const TOOLS: Tool[] = [
  {
    name: 'list_collections',
    description:
      'List every cookbook / personal collection / web collection the user owns. ' +
      'Returns id, title, source_type, author, isbn, and recipe count.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async run(_args, client) {
      // Reuse the full export (already owner-scoped, already JSON).
      const lib = await client.call<{ collections: Array<Record<string, unknown>> }>(
        'cli_export_library',
        {},
      );
      return (lib.collections ?? []).map((c) => ({
        id: c.id,
        title: c.title,
        source_type: c.source_type,
        author: c.author ?? null,
        isbn: c.isbn ?? null,
        publisher: c.publisher ?? null,
        publication_year: c.publication_year ?? null,
        is_public: c.is_public ?? false,
        recipe_count: Array.isArray(c.recipes) ? c.recipes.length : 0,
      }));
    },
  },
  {
    name: 'get_collection',
    description:
      "Return a single collection's metadata plus its recipes as a titles-only " +
      'table of contents. Use `get_recipe` for the full body of any individual recipe.',
    inputSchema: {
      type: 'object',
      properties: {
        collection_id: { type: 'string', description: 'UUID of the collection' },
      },
      required: ['collection_id'],
      additionalProperties: false,
    },
    async run(args, client) {
      const cid = s(args.collection_id, 'collection_id');
      const toc = await client.call<{ collections: Array<Record<string, unknown>> }>(
        'cli_export_toc',
        { collection_id: cid },
      );
      return toc.collections?.[0] ?? null;
    },
  },
  {
    name: 'get_recipe',
    description:
      'Return one recipe in full — ingredients, instructions, notes, lineage. ' +
      'Use when the user asks for instructions, amounts, or wants to cook a dish.',
    inputSchema: {
      type: 'object',
      properties: {
        recipe_id: { type: 'string', description: 'UUID of the recipe' },
      },
      required: ['recipe_id'],
      additionalProperties: false,
    },
    async run(args, client) {
      const id = s(args.recipe_id, 'recipe_id');
      return client.call('cli_get_recipe', { recipe_id: id });
    },
  },
  {
    name: 'search_recipes',
    description:
      "Case-insensitive substring search across the user's recipe titles AND " +
      'ingredient names. Returns a lean hit list ({collection_id, collection_title, ' +
      'recipe_id, recipe_title}) — follow up with `get_recipe` for full details.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        max_results: { type: 'integer', minimum: 1, maximum: 100 },
      },
      required: ['query'],
      additionalProperties: false,
    },
    async run(args, client) {
      const query = s(args.query, 'query');
      const max = typeof args.max_results === 'number' ? args.max_results : null;
      return client.call('cli_search_recipes', { query, max_results: max });
    },
  },
  {
    name: 'create_recipe',
    description:
      "Create a new recipe in one of the user's collections. If `collection_id` is " +
      'omitted the recipe lands in an auto-created "CLI imports" collection. ' +
      '`recipe` should include title, optional servings_amount / servings_description, ' +
      'ingredients[], and instructions[] (matching the `get_recipe` output shape).',
    inputSchema: {
      type: 'object',
      properties: {
        collection_id: { type: 'string' },
        recipe: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            servings_amount: { type: 'number' },
            servings_description: { type: 'string' },
            ingredients: { type: 'array' },
            instructions: { type: 'array' },
            notes: { type: 'string' },
          },
          required: ['title'],
        },
      },
      required: ['recipe'],
      additionalProperties: false,
    },
    async run(args, client) {
      const recipe = args.recipe;
      if (!recipe || typeof recipe !== 'object') throw new Error('recipe is required');
      const cid =
        typeof args.collection_id === 'string' && args.collection_id
          ? args.collection_id
          : null;
      const id = await client.call<string>('cli_import_recipe', {
        target_collection_id: cid,
        recipe,
      });
      return { id };
    },
  },
  {
    name: 'list_shopping_items',
    description:
      "List every item on the user's persistent shopping list ('pantry' / extras, " +
      'distinct from the web-app recipe aggregation view). Unchecked items come first.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async run(_args, client) {
      return client.call('cli_list_shopping', {});
    },
  },
  {
    name: 'add_shopping_item',
    description:
      "Add an item to the user's shopping list. Use this for pantry additions or " +
      "when turning a recipe's ingredients into a shopping plan (one call per ingredient).",
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The thing to buy, e.g. "whole milk"' },
        quantity_text: {
          type: 'string',
          description: 'Free-form amount, e.g. "1 gallon" or "2 cups"',
        },
        note: { type: 'string', description: 'Extra context, e.g. "organic if possible"' },
        recipe_id: {
          type: 'string',
          description: 'Optional UUID of the recipe this came from',
        },
      },
      required: ['name'],
      additionalProperties: false,
    },
    async run(args, client) {
      const name = s(args.name, 'name');
      return client.call('cli_add_shopping', {
        name,
        quantity_text: opt(args.quantity_text as string | undefined),
        note: opt(args.note as string | undefined),
        recipe_id: opt(args.recipe_id as string | undefined),
      });
    },
  },
  {
    name: 'check_shopping_item',
    description:
      'Mark a shopping list item as checked (picked up) or unchecked. Pass ' +
      '`checked: true` to check, `checked: false` to restore it.',
    inputSchema: {
      type: 'object',
      properties: {
        item_id: { type: 'string' },
        checked: { type: 'boolean' },
      },
      required: ['item_id', 'checked'],
      additionalProperties: false,
    },
    async run(args, client) {
      const id = s(args.item_id, 'item_id');
      if (typeof args.checked !== 'boolean') throw new Error('checked must be boolean');
      await client.call('cli_check_shopping', { item_id: id, checked: args.checked });
      return { item_id: id, checked: args.checked };
    },
  },
  {
    name: 'remove_shopping_item',
    description: 'Delete a shopping list item.',
    inputSchema: {
      type: 'object',
      properties: { item_id: { type: 'string' } },
      required: ['item_id'],
      additionalProperties: false,
    },
    async run(args, client) {
      const id = s(args.item_id, 'item_id');
      await client.call('cli_remove_shopping', { item_id: id });
      return { removed: id };
    },
  },
  {
    name: 'clear_shopping_list',
    description:
      'Delete shopping list items. Pass `only_checked: true` to clear just the ' +
      'items the user has already picked up.',
    inputSchema: {
      type: 'object',
      properties: { only_checked: { type: 'boolean' } },
      additionalProperties: false,
    },
    async run(args, client) {
      const onlyChecked = args.only_checked === true;
      const deleted = await client.call<number>('cli_clear_shopping', {
        only_checked: onlyChecked,
      });
      return { deleted };
    },
  },
];

export const TOOL_INDEX: Record<string, Tool> = Object.fromEntries(
  TOOLS.map((t) => [t.name, t]),
);
