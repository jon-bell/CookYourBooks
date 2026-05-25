export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      admins: {
        Row: {
          granted_at: string
          granted_by: string | null
          note: string | null
          user_id: string
        }
        Insert: {
          granted_at?: string
          granted_by?: string | null
          note?: string | null
          user_id: string
        }
        Update: {
          granted_at?: string
          granted_by?: string | null
          note?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "admins_granted_by_fkey"
            columns: ["granted_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "admins_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: true
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      cli_tokens: {
        Row: {
          created_at: string
          id: string
          last_used_at: string | null
          name: string
          owner_id: string
          prefix: string
          token_hash: string
        }
        Insert: {
          created_at?: string
          id?: string
          last_used_at?: string | null
          name: string
          owner_id: string
          prefix: string
          token_hash: string
        }
        Update: {
          created_at?: string
          id?: string
          last_used_at?: string | null
          name?: string
          owner_id?: string
          prefix?: string
          token_hash?: string
        }
        Relationships: [
          {
            foreignKeyName: "cli_tokens_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      conversion_rules: {
        Row: {
          factor: number
          from_unit: string
          id: string
          ingredient_name: string | null
          owner_id: string
          priority: string
          recipe_id: string | null
          to_unit: string
        }
        Insert: {
          factor: number
          from_unit: string
          id?: string
          ingredient_name?: string | null
          owner_id: string
          priority: string
          recipe_id?: string | null
          to_unit: string
        }
        Update: {
          factor?: number
          from_unit?: string
          id?: string
          ingredient_name?: string | null
          owner_id?: string
          priority?: string
          recipe_id?: string | null
          to_unit?: string
        }
        Relationships: [
          {
            foreignKeyName: "conversion_rules_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "conversion_rules_recipe_id_fkey"
            columns: ["recipe_id"]
            isOneToOne: false
            referencedRelation: "recipes"
            referencedColumns: ["id"]
          },
        ]
      }
      global_cookbooks: {
        Row: {
          author: string | null
          cover_image_path: string | null
          created_at: string
          id: string
          isbn: string | null
          notes: string | null
          publication_year: number | null
          publisher: string | null
          shared_from_collection_id: string | null
          title: string
          updated_at: string
        }
        Insert: {
          author?: string | null
          cover_image_path?: string | null
          created_at?: string
          id?: string
          isbn?: string | null
          notes?: string | null
          publication_year?: number | null
          publisher?: string | null
          shared_from_collection_id?: string | null
          title: string
          updated_at?: string
        }
        Update: {
          author?: string | null
          cover_image_path?: string | null
          created_at?: string
          id?: string
          isbn?: string | null
          notes?: string | null
          publication_year?: number | null
          publisher?: string | null
          shared_from_collection_id?: string | null
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "global_cookbooks_shared_from_collection_id_fkey"
            columns: ["shared_from_collection_id"]
            isOneToOne: false
            referencedRelation: "admin_global_toc_import_candidates"
            referencedColumns: ["collection_id"]
          },
          {
            foreignKeyName: "global_cookbooks_shared_from_collection_id_fkey"
            columns: ["shared_from_collection_id"]
            isOneToOne: false
            referencedRelation: "public_collections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "global_cookbooks_shared_from_collection_id_fkey"
            columns: ["shared_from_collection_id"]
            isOneToOne: false
            referencedRelation: "recipe_collections"
            referencedColumns: ["id"]
          },
        ]
      }
      global_toc_entries: {
        Row: {
          cookbook_id: string
          created_at: string
          id: string
          page_number: number | null
          sort_order: number
          title: string
          updated_at: string
        }
        Insert: {
          cookbook_id: string
          created_at?: string
          id?: string
          page_number?: number | null
          sort_order?: number
          title: string
          updated_at?: string
        }
        Update: {
          cookbook_id?: string
          created_at?: string
          id?: string
          page_number?: number | null
          sort_order?: number
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "global_toc_entries_cookbook_id_fkey"
            columns: ["cookbook_id"]
            isOneToOne: false
            referencedRelation: "global_cookbooks"
            referencedColumns: ["id"]
          },
        ]
      }
      import_batches: {
        Row: {
          created_at: string
          default_model: string
          default_provider: string
          fallback_model: string | null
          fallback_provider: string | null
          id: string
          name: string
          owner_id: string
          recitation_policy: string
          source_kind: string
          status: string
          target_collection_id: string | null
          total_items: number
          updated_at: string
        }
        Insert: {
          created_at?: string
          default_model?: string
          default_provider?: string
          fallback_model?: string | null
          fallback_provider?: string | null
          id?: string
          name?: string
          owner_id: string
          recitation_policy?: string
          source_kind?: string
          status?: string
          target_collection_id?: string | null
          total_items?: number
          updated_at?: string
        }
        Update: {
          created_at?: string
          default_model?: string
          default_provider?: string
          fallback_model?: string | null
          fallback_provider?: string | null
          id?: string
          name?: string
          owner_id?: string
          recitation_policy?: string
          source_kind?: string
          status?: string
          target_collection_id?: string | null
          total_items?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "import_batches_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "import_batches_target_collection_id_fkey"
            columns: ["target_collection_id"]
            isOneToOne: false
            referencedRelation: "admin_global_toc_import_candidates"
            referencedColumns: ["collection_id"]
          },
          {
            foreignKeyName: "import_batches_target_collection_id_fkey"
            columns: ["target_collection_id"]
            isOneToOne: false
            referencedRelation: "public_collections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "import_batches_target_collection_id_fkey"
            columns: ["target_collection_id"]
            isOneToOne: false
            referencedRelation: "recipe_collections"
            referencedColumns: ["id"]
          },
        ]
      }
      import_item_attempts: {
        Row: {
          attempt_no: number
          completion_tokens: number
          cost_usd_micros: number
          error_kind: string | null
          error_message: string | null
          finished_at: string | null
          id: string
          item_id: string
          latency_ms: number
          model: string
          owner_id: string
          prompt_tokens: number
          provider: string
          raw_response_path: string | null
          started_at: string
        }
        Insert: {
          attempt_no?: number
          completion_tokens?: number
          cost_usd_micros?: number
          error_kind?: string | null
          error_message?: string | null
          finished_at?: string | null
          id?: string
          item_id: string
          latency_ms?: number
          model?: string
          owner_id: string
          prompt_tokens?: number
          provider?: string
          raw_response_path?: string | null
          started_at?: string
        }
        Update: {
          attempt_no?: number
          completion_tokens?: number
          cost_usd_micros?: number
          error_kind?: string | null
          error_message?: string | null
          finished_at?: string | null
          id?: string
          item_id?: string
          latency_ms?: number
          model?: string
          owner_id?: string
          prompt_tokens?: number
          provider?: string
          raw_response_path?: string | null
          started_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "import_item_attempts_item_id_fkey"
            columns: ["item_id"]
            isOneToOne: false
            referencedRelation: "import_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "import_item_attempts_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      import_items: {
        Row: {
          assigned_collection_id: string | null
          assigned_page_number: number | null
          attempts: number
          batch_id: string
          claim_expires_at: string
          claim_token: string | null
          completion_tokens: number
          cost_usd_micros: number
          created_at: string
          created_recipe_ids: string[]
          extra_storage_paths: string[]
          id: string
          is_toc: boolean
          last_error: string | null
          model_used: string | null
          needs_fallback: boolean
          owner_id: string
          page_index: number
          parsed_drafts_json: Json | null
          prompt_tokens: number
          source_pdf_page: number | null
          source_pdf_path: string | null
          status: string
          storage_path: string
          thumb_path: string | null
          updated_at: string
        }
        Insert: {
          assigned_collection_id?: string | null
          assigned_page_number?: number | null
          attempts?: number
          batch_id: string
          claim_expires_at?: string
          claim_token?: string | null
          completion_tokens?: number
          cost_usd_micros?: number
          created_at?: string
          created_recipe_ids?: string[]
          extra_storage_paths?: string[]
          id?: string
          is_toc?: boolean
          last_error?: string | null
          model_used?: string | null
          needs_fallback?: boolean
          owner_id: string
          page_index?: number
          parsed_drafts_json?: Json | null
          prompt_tokens?: number
          source_pdf_page?: number | null
          source_pdf_path?: string | null
          status?: string
          storage_path?: string
          thumb_path?: string | null
          updated_at?: string
        }
        Update: {
          assigned_collection_id?: string | null
          assigned_page_number?: number | null
          attempts?: number
          batch_id?: string
          claim_expires_at?: string
          claim_token?: string | null
          completion_tokens?: number
          cost_usd_micros?: number
          created_at?: string
          created_recipe_ids?: string[]
          extra_storage_paths?: string[]
          id?: string
          is_toc?: boolean
          last_error?: string | null
          model_used?: string | null
          needs_fallback?: boolean
          owner_id?: string
          page_index?: number
          parsed_drafts_json?: Json | null
          prompt_tokens?: number
          source_pdf_page?: number | null
          source_pdf_path?: string | null
          status?: string
          storage_path?: string
          thumb_path?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "import_items_assigned_collection_id_fkey"
            columns: ["assigned_collection_id"]
            isOneToOne: false
            referencedRelation: "admin_global_toc_import_candidates"
            referencedColumns: ["collection_id"]
          },
          {
            foreignKeyName: "import_items_assigned_collection_id_fkey"
            columns: ["assigned_collection_id"]
            isOneToOne: false
            referencedRelation: "public_collections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "import_items_assigned_collection_id_fkey"
            columns: ["assigned_collection_id"]
            isOneToOne: false
            referencedRelation: "recipe_collections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "import_items_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "import_batches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "import_items_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      import_toc_entries: {
        Row: {
          batch_id: string
          confidence: number
          created_at: string
          id: string
          item_id: string
          owner_id: string
          page_number: number | null
          title: string
          updated_at: string
        }
        Insert: {
          batch_id: string
          confidence?: number
          created_at?: string
          id?: string
          item_id: string
          owner_id: string
          page_number?: number | null
          title?: string
          updated_at?: string
        }
        Update: {
          batch_id?: string
          confidence?: number
          created_at?: string
          id?: string
          item_id?: string
          owner_id?: string
          page_number?: number | null
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "import_toc_entries_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "import_batches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "import_toc_entries_item_id_fkey"
            columns: ["item_id"]
            isOneToOne: false
            referencedRelation: "import_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "import_toc_entries_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      ingredients: {
        Row: {
          description: string | null
          id: string
          name: string
          notes: string | null
          preparation: string | null
          quantity_amount: number | null
          quantity_denominator: number | null
          quantity_max: number | null
          quantity_min: number | null
          quantity_numerator: number | null
          quantity_type: string | null
          quantity_unit: string | null
          quantity_whole: number | null
          recipe_id: string
          sort_order: number
          type: string
        }
        Insert: {
          description?: string | null
          id?: string
          name: string
          notes?: string | null
          preparation?: string | null
          quantity_amount?: number | null
          quantity_denominator?: number | null
          quantity_max?: number | null
          quantity_min?: number | null
          quantity_numerator?: number | null
          quantity_type?: string | null
          quantity_unit?: string | null
          quantity_whole?: number | null
          recipe_id: string
          sort_order: number
          type: string
        }
        Update: {
          description?: string | null
          id?: string
          name?: string
          notes?: string | null
          preparation?: string | null
          quantity_amount?: number | null
          quantity_denominator?: number | null
          quantity_max?: number | null
          quantity_min?: number | null
          quantity_numerator?: number | null
          quantity_type?: string | null
          quantity_unit?: string | null
          quantity_whole?: number | null
          recipe_id?: string
          sort_order?: number
          type?: string
        }
        Relationships: [
          {
            foreignKeyName: "ingredients_recipe_id_fkey"
            columns: ["recipe_id"]
            isOneToOne: false
            referencedRelation: "recipes"
            referencedColumns: ["id"]
          },
        ]
      }
      instruction_ingredient_refs: {
        Row: {
          consumed_quantity_amount: number | null
          consumed_quantity_denominator: number | null
          consumed_quantity_max: number | null
          consumed_quantity_min: number | null
          consumed_quantity_numerator: number | null
          consumed_quantity_type: string | null
          consumed_quantity_unit: string | null
          consumed_quantity_whole: number | null
          ingredient_id: string
          instruction_id: string
        }
        Insert: {
          consumed_quantity_amount?: number | null
          consumed_quantity_denominator?: number | null
          consumed_quantity_max?: number | null
          consumed_quantity_min?: number | null
          consumed_quantity_numerator?: number | null
          consumed_quantity_type?: string | null
          consumed_quantity_unit?: string | null
          consumed_quantity_whole?: number | null
          ingredient_id: string
          instruction_id: string
        }
        Update: {
          consumed_quantity_amount?: number | null
          consumed_quantity_denominator?: number | null
          consumed_quantity_max?: number | null
          consumed_quantity_min?: number | null
          consumed_quantity_numerator?: number | null
          consumed_quantity_type?: string | null
          consumed_quantity_unit?: string | null
          consumed_quantity_whole?: number | null
          ingredient_id?: string
          instruction_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "instruction_ingredient_refs_ingredient_id_fkey"
            columns: ["ingredient_id"]
            isOneToOne: false
            referencedRelation: "ingredients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "instruction_ingredient_refs_instruction_id_fkey"
            columns: ["instruction_id"]
            isOneToOne: false
            referencedRelation: "instructions"
            referencedColumns: ["id"]
          },
        ]
      }
      instructions: {
        Row: {
          id: string
          notes: string | null
          recipe_id: string
          step_number: number
          sub_instructions: Json | null
          temperature_unit: string | null
          temperature_value: number | null
          text: string
        }
        Insert: {
          id?: string
          notes?: string | null
          recipe_id: string
          step_number: number
          sub_instructions?: Json | null
          temperature_unit?: string | null
          temperature_value?: number | null
          text: string
        }
        Update: {
          id?: string
          notes?: string | null
          recipe_id?: string
          step_number?: number
          sub_instructions?: Json | null
          temperature_unit?: string | null
          temperature_value?: number | null
          text?: string
        }
        Relationships: [
          {
            foreignKeyName: "instructions_recipe_id_fkey"
            columns: ["recipe_id"]
            isOneToOne: false
            referencedRelation: "recipes"
            referencedColumns: ["id"]
          },
        ]
      }
      moderation_actions: {
        Row: {
          action: string
          admin_id: string | null
          created_at: string
          id: string
          reason: string | null
          target_id: string
          target_type: string
        }
        Insert: {
          action: string
          admin_id?: string | null
          created_at?: string
          id?: string
          reason?: string | null
          target_id: string
          target_type: string
        }
        Update: {
          action?: string
          admin_id?: string | null
          created_at?: string
          id?: string
          reason?: string | null
          target_id?: string
          target_type?: string
        }
        Relationships: [
          {
            foreignKeyName: "moderation_actions_admin_id_fkey"
            columns: ["admin_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      ocr_test_fixtures: {
        Row: {
          created_at: string
          error_kind: string | null
          item_storage_path: string
          latency_ms: number
          provider: string
          response_json: Json
        }
        Insert: {
          created_at?: string
          error_kind?: string | null
          item_storage_path: string
          latency_ms?: number
          provider?: string
          response_json?: Json
        }
        Update: {
          created_at?: string
          error_kind?: string | null
          item_storage_path?: string
          latency_ms?: number
          provider?: string
          response_json?: Json
        }
        Relationships: []
      }
      profiles: {
        Row: {
          avatar_url: string | null
          created_at: string
          disabled: boolean
          disabled_reason: string | null
          display_name: string | null
          id: string
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string
          disabled?: boolean
          disabled_reason?: string | null
          display_name?: string | null
          id: string
        }
        Update: {
          avatar_url?: string | null
          created_at?: string
          disabled?: boolean
          disabled_reason?: string | null
          display_name?: string | null
          id?: string
        }
        Relationships: []
      }
      recipe_collections: {
        Row: {
          author: string | null
          cover_image_path: string | null
          created_at: string
          date_accessed: string | null
          description: string | null
          forked_from: string | null
          id: string
          is_public: boolean
          isbn: string | null
          moderation_reason: string | null
          moderation_state: string
          notes: string | null
          owner_id: string
          publication_year: number | null
          publisher: string | null
          site_name: string | null
          source_type: string
          source_url: string | null
          title: string
          updated_at: string
        }
        Insert: {
          author?: string | null
          cover_image_path?: string | null
          created_at?: string
          date_accessed?: string | null
          description?: string | null
          forked_from?: string | null
          id?: string
          is_public?: boolean
          isbn?: string | null
          moderation_reason?: string | null
          moderation_state?: string
          notes?: string | null
          owner_id: string
          publication_year?: number | null
          publisher?: string | null
          site_name?: string | null
          source_type: string
          source_url?: string | null
          title: string
          updated_at?: string
        }
        Update: {
          author?: string | null
          cover_image_path?: string | null
          created_at?: string
          date_accessed?: string | null
          description?: string | null
          forked_from?: string | null
          id?: string
          is_public?: boolean
          isbn?: string | null
          moderation_reason?: string | null
          moderation_state?: string
          notes?: string | null
          owner_id?: string
          publication_year?: number | null
          publisher?: string | null
          site_name?: string | null
          source_type?: string
          source_url?: string | null
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "recipe_collections_forked_from_fkey"
            columns: ["forked_from"]
            isOneToOne: false
            referencedRelation: "admin_global_toc_import_candidates"
            referencedColumns: ["collection_id"]
          },
          {
            foreignKeyName: "recipe_collections_forked_from_fkey"
            columns: ["forked_from"]
            isOneToOne: false
            referencedRelation: "public_collections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "recipe_collections_forked_from_fkey"
            columns: ["forked_from"]
            isOneToOne: false
            referencedRelation: "recipe_collections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "recipe_collections_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      recipes: {
        Row: {
          book_title: string | null
          collection_id: string
          created_at: string
          description: string | null
          equipment: Json | null
          id: string
          notes: string | null
          page_numbers: Json | null
          parent_recipe_id: string | null
          servings_amount: number | null
          servings_amount_max: number | null
          servings_description: string | null
          sort_order: number
          source_image_text: string | null
          time_estimate: string | null
          title: string
          updated_at: string
        }
        Insert: {
          book_title?: string | null
          collection_id: string
          created_at?: string
          description?: string | null
          equipment?: Json | null
          id?: string
          notes?: string | null
          page_numbers?: Json | null
          parent_recipe_id?: string | null
          servings_amount?: number | null
          servings_amount_max?: number | null
          servings_description?: string | null
          sort_order?: number
          source_image_text?: string | null
          time_estimate?: string | null
          title: string
          updated_at?: string
        }
        Update: {
          book_title?: string | null
          collection_id?: string
          created_at?: string
          description?: string | null
          equipment?: Json | null
          id?: string
          notes?: string | null
          page_numbers?: Json | null
          parent_recipe_id?: string | null
          servings_amount?: number | null
          servings_amount_max?: number | null
          servings_description?: string | null
          sort_order?: number
          source_image_text?: string | null
          time_estimate?: string | null
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "recipes_collection_id_fkey"
            columns: ["collection_id"]
            isOneToOne: false
            referencedRelation: "admin_global_toc_import_candidates"
            referencedColumns: ["collection_id"]
          },
          {
            foreignKeyName: "recipes_collection_id_fkey"
            columns: ["collection_id"]
            isOneToOne: false
            referencedRelation: "public_collections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "recipes_collection_id_fkey"
            columns: ["collection_id"]
            isOneToOne: false
            referencedRelation: "recipe_collections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "recipes_parent_recipe_id_fkey"
            columns: ["parent_recipe_id"]
            isOneToOne: false
            referencedRelation: "recipes"
            referencedColumns: ["id"]
          },
        ]
      }
      reports: {
        Row: {
          created_at: string
          id: string
          message: string | null
          reason: string
          reporter_id: string | null
          resolved_at: string | null
          resolved_by: string | null
          status: string
          target_id: string
          target_type: string
        }
        Insert: {
          created_at?: string
          id?: string
          message?: string | null
          reason: string
          reporter_id?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          status?: string
          target_id: string
          target_type: string
        }
        Update: {
          created_at?: string
          id?: string
          message?: string | null
          reason?: string
          reporter_id?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          status?: string
          target_id?: string
          target_type?: string
        }
        Relationships: [
          {
            foreignKeyName: "reports_reporter_id_fkey"
            columns: ["reporter_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reports_resolved_by_fkey"
            columns: ["resolved_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      shopping_list_items: {
        Row: {
          checked: boolean
          created_at: string
          id: string
          name: string
          note: string | null
          owner_id: string
          quantity_text: string | null
          recipe_id: string | null
          updated_at: string
        }
        Insert: {
          checked?: boolean
          created_at?: string
          id?: string
          name: string
          note?: string | null
          owner_id: string
          quantity_text?: string | null
          recipe_id?: string | null
          updated_at?: string
        }
        Update: {
          checked?: boolean
          created_at?: string
          id?: string
          name?: string
          note?: string | null
          owner_id?: string
          quantity_text?: string | null
          recipe_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "shopping_list_items_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shopping_list_items_recipe_id_fkey"
            columns: ["recipe_id"]
            isOneToOne: false
            referencedRelation: "recipes"
            referencedColumns: ["id"]
          },
        ]
      }
      user_ocr_keys: {
        Row: {
          base_url: string | null
          created_at: string
          key_fingerprint: string
          owner_id: string
          provider: string
          rotated_at: string
          vault_secret_id: string
        }
        Insert: {
          base_url?: string | null
          created_at?: string
          key_fingerprint: string
          owner_id: string
          provider: string
          rotated_at?: string
          vault_secret_id: string
        }
        Update: {
          base_url?: string | null
          created_at?: string
          key_fingerprint?: string
          owner_id?: string
          provider?: string
          rotated_at?: string
          vault_secret_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_ocr_keys_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      admin_global_toc_import_candidates: {
        Row: {
          author: string | null
          collection_id: string | null
          cover_image_path: string | null
          created_at: string | null
          isbn: string | null
          owner_id: string | null
          owner_name: string | null
          publication_year: number | null
          publisher: string | null
          raw_isbn: string | null
          recipe_count: number | null
          title: string | null
        }
        Relationships: [
          {
            foreignKeyName: "recipe_collections_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      public_collections: {
        Row: {
          author: string | null
          cover_image_path: string | null
          id: string | null
          owner_name: string | null
          recipe_count: number | null
          source_type: string | null
          title: string | null
        }
        Relationships: []
      }
    }
    Functions: {
      cli_add_shopping: {
        Args: {
          name: string
          note?: string
          quantity_text?: string
          raw_token: string
          recipe_id?: string
        }
        Returns: Json
      }
      cli_check_shopping: {
        Args: { checked: boolean; item_id: string; raw_token: string }
        Returns: boolean
      }
      cli_clear_shopping: {
        Args: { only_checked?: boolean; raw_token: string }
        Returns: number
      }
      cli_export_library: { Args: { raw_token: string }; Returns: Json }
      cli_export_toc: {
        Args: { collection_id?: string; raw_token: string }
        Returns: Json
      }
      cli_get_recipe: {
        Args: { raw_token: string; recipe_id: string }
        Returns: Json
      }
      cli_import_cookbook: {
        Args: { entries: Json; metadata: Json; raw_token: string }
        Returns: Json
      }
      cli_import_recipe: {
        Args: { raw_token: string; recipe: Json; target_collection_id: string }
        Returns: string
      }
      cli_import_toc: {
        Args: {
          raw_token: string
          target_collection_id: string
          titles: string[]
        }
        Returns: string[]
      }
      cli_issue_token: { Args: { token_name: string }; Returns: string }
      cli_list_shopping: { Args: { raw_token: string }; Returns: Json }
      cli_remove_shopping: {
        Args: { item_id: string; raw_token: string }
        Returns: boolean
      }
      cli_search_recipes: {
        Args: { max_results?: number; query: string; raw_token: string }
        Returns: Json
      }
      cli_verify_token: { Args: { raw_token: string }; Returns: string }
      fork_collection: {
        Args: { source_collection_id: string }
        Returns: string
      }
      global_toc_admin_import: {
        Args: { source_collection_id: string }
        Returns: string
      }
      global_toc_replace_entries_from_collection: {
        Args: { source_collection_id: string; target_cookbook_id: string }
        Returns: undefined
      }
      global_toc_share_collection: {
        Args: { source_collection_id: string }
        Returns: string
      }
      import_claim_next: {
        Args: {
          p_batch_id?: string
          p_lease_seconds?: number
          p_limit?: number
          p_worker_id: string
        }
        Returns: {
          assigned_collection_id: string | null
          assigned_page_number: number | null
          attempts: number
          batch_id: string
          claim_expires_at: string
          claim_token: string | null
          completion_tokens: number
          cost_usd_micros: number
          created_at: string
          created_recipe_ids: string[]
          extra_storage_paths: string[]
          id: string
          is_toc: boolean
          last_error: string | null
          model_used: string | null
          needs_fallback: boolean
          owner_id: string
          page_index: number
          parsed_drafts_json: Json | null
          prompt_tokens: number
          source_pdf_page: number | null
          source_pdf_path: string | null
          status: string
          storage_path: string
          thumb_path: string | null
          updated_at: string
        }[]
        SetofOptions: {
          from: "*"
          to: "import_items"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      import_complete: {
        Args: {
          p_attempt: Json
          p_claim_token: string
          p_item_id: string
          p_parsed_drafts: Json
        }
        Returns: boolean
      }
      import_expire_stale_claims: { Args: never; Returns: number }
      import_fail: {
        Args: {
          p_attempt: Json
          p_claim_token: string
          p_item_id: string
          p_next_state: string
        }
        Returns: boolean
      }
      import_finalize_grouping: {
        Args: { p_batch_id: string; p_groups: Json }
        Returns: undefined
      }
      import_merge_items: {
        Args: { p_absorb_ids: string[]; p_primary_id: string }
        Returns: undefined
      }
      import_reset_item: { Args: { p_item_id: string }; Returns: undefined }
      import_retry_recitation_failures: {
        Args: { p_batch_id: string }
        Returns: number
      }
      import_set_batch_fallback: {
        Args: { p_batch_id: string; p_provider: string | null; p_model: string | null }
        Returns: undefined
      }
      import_set_recitation_policy: {
        Args: { p_batch_id: string; p_policy: string }
        Returns: undefined
      }
      is_admin: { Args: { uid: string }; Returns: boolean }
      moderation_ban_user: {
        Args: { reason: string; target_user_id: string }
        Returns: undefined
      }
      moderation_dismiss_report: {
        Args: { note: string; target_report_id: string }
        Returns: undefined
      }
      moderation_grant_admin: {
        Args: { note: string; target_user_id: string }
        Returns: undefined
      }
      moderation_republish_collection: {
        Args: { reason: string; target_collection_id: string }
        Returns: undefined
      }
      moderation_revoke_admin: {
        Args: { reason: string; target_user_id: string }
        Returns: undefined
      }
      moderation_unban_user: {
        Args: { reason: string; target_user_id: string }
        Returns: undefined
      }
      moderation_unpublish_collection: {
        Args: { reason: string; target_collection_id: string }
        Returns: undefined
      }
      normalize_isbn: { Args: { raw: string }; Returns: string }
      ocr_key_delete: { Args: { p_provider: string }; Returns: undefined }
      ocr_key_set: {
        Args: { p_base_url?: string; p_provider: string; p_raw_key: string }
        Returns: undefined
      }
      ocr_kick: { Args: { p_batch_id?: string }; Returns: undefined }
      ocr_resolve_key: {
        Args: { p_owner_id: string; p_provider: string }
        Returns: {
          api_key: string
          base_url: string
        }[]
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {},
  },
} as const

