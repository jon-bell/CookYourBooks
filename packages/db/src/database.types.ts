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
      audit_log: {
        Row: {
          action: string
          actor_id: string | null
          created_at: string
          household_id: string | null
          id: string
          metadata: Json
          target_id: string | null
          target_type: string
        }
        Insert: {
          action: string
          actor_id?: string | null
          created_at?: string
          household_id?: string | null
          id?: string
          metadata?: Json
          target_id?: string | null
          target_type: string
        }
        Update: {
          action?: string
          actor_id?: string | null
          created_at?: string
          household_id?: string | null
          id?: string
          metadata?: Json
          target_id?: string | null
          target_type?: string
        }
        Relationships: [
          {
            foreignKeyName: "audit_log_actor_id_fkey"
            columns: ["actor_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "audit_log_household_id_fkey"
            columns: ["household_id"]
            isOneToOne: false
            referencedRelation: "households"
            referencedColumns: ["id"]
          },
        ]
      }
      bakeoff_runs: {
        Row: {
          created_at: string
          id: string
          image_storage_path: string | null
          input_recipe_id: string | null
          owner_id: string
          status: string
          task_kind: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          image_storage_path?: string | null
          input_recipe_id?: string | null
          owner_id: string
          status?: string
          task_kind?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          image_storage_path?: string | null
          input_recipe_id?: string | null
          owner_id?: string
          status?: string
          task_kind?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "bakeoff_runs_input_recipe_id_fkey"
            columns: ["input_recipe_id"]
            isOneToOne: false
            referencedRelation: "recipes"
            referencedColumns: ["id"]
          },
        ]
      }
      bakeoff_variants: {
        Row: {
          attempts: number
          base_url: string | null
          claim_expires_at: string
          claim_token: string | null
          completion_tokens: number | null
          cost_usd_micros: number | null
          created_at: string
          drafts: Json | null
          error_kind: string | null
          error_message: string | null
          id: string
          latency_ms: number | null
          model: string
          name: string
          owner_id: string
          prompt: string
          prompt_tokens: number | null
          provider: string
          raw_text: string | null
          run_id: string
          sort_index: number
          status: string
          updated_at: string
        }
        Insert: {
          attempts?: number
          base_url?: string | null
          claim_expires_at?: string
          claim_token?: string | null
          completion_tokens?: number | null
          cost_usd_micros?: number | null
          created_at?: string
          drafts?: Json | null
          error_kind?: string | null
          error_message?: string | null
          id?: string
          latency_ms?: number | null
          model: string
          name?: string
          owner_id: string
          prompt: string
          prompt_tokens?: number | null
          provider: string
          raw_text?: string | null
          run_id: string
          sort_index?: number
          status?: string
          updated_at?: string
        }
        Update: {
          attempts?: number
          base_url?: string | null
          claim_expires_at?: string
          claim_token?: string | null
          completion_tokens?: number | null
          cost_usd_micros?: number | null
          created_at?: string
          drafts?: Json | null
          error_kind?: string | null
          error_message?: string | null
          id?: string
          latency_ms?: number | null
          model?: string
          name?: string
          owner_id?: string
          prompt?: string
          prompt_tokens?: number | null
          provider?: string
          raw_text?: string | null
          run_id?: string
          sort_index?: number
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "bakeoff_variants_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "bakeoff_runs"
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
          created_at: string
          factor: number
          from_unit: string
          id: string
          ingredient_name: string | null
          notes: string | null
          owner_id: string
          priority: string
          recipe_id: string | null
          to_unit: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          factor: number
          from_unit: string
          id?: string
          ingredient_name?: string | null
          notes?: string | null
          owner_id: string
          priority: string
          recipe_id?: string | null
          to_unit: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          factor?: number
          from_unit?: string
          id?: string
          ingredient_name?: string | null
          notes?: string | null
          owner_id?: string
          priority?: string
          recipe_id?: string | null
          to_unit?: string
          updated_at?: string
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
      global_conversions: {
        Row: {
          created_at: string
          created_by: string | null
          factor: number
          from_unit: string
          id: string
          ingredient_name: string | null
          notes: string | null
          to_unit: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          factor: number
          from_unit: string
          id?: string
          ingredient_name?: string | null
          notes?: string | null
          to_unit: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          created_at?: string
          created_by?: string | null
          factor?: number
          from_unit?: string
          id?: string
          ingredient_name?: string | null
          notes?: string | null
          to_unit?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "global_conversions_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "global_conversions_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "profiles"
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
      household_invites: {
        Row: {
          created_at: string
          created_by: string
          expires_at: string
          household_id: string
          id: string
          revoked_at: string | null
          token: string
          used_at: string | null
          used_by: string | null
        }
        Insert: {
          created_at?: string
          created_by: string
          expires_at: string
          household_id: string
          id?: string
          revoked_at?: string | null
          token: string
          used_at?: string | null
          used_by?: string | null
        }
        Update: {
          created_at?: string
          created_by?: string
          expires_at?: string
          household_id?: string
          id?: string
          revoked_at?: string | null
          token?: string
          used_at?: string | null
          used_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "household_invites_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "household_invites_household_id_fkey"
            columns: ["household_id"]
            isOneToOne: false
            referencedRelation: "households"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "household_invites_used_by_fkey"
            columns: ["used_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      household_join_cooldowns: {
        Row: {
          eligible_at: string
          reason: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          eligible_at: string
          reason?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          eligible_at?: string
          reason?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "household_join_cooldowns_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: true
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      household_members: {
        Row: {
          attested_tos_version: number
          household_id: string
          id: string
          joined_at: string
          left_at: string | null
          role: string
          updated_at: string
          user_id: string
        }
        Insert: {
          attested_tos_version?: number
          household_id: string
          id?: string
          joined_at?: string
          left_at?: string | null
          role?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          attested_tos_version?: number
          household_id?: string
          id?: string
          joined_at?: string
          left_at?: string | null
          role?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "household_members_household_id_fkey"
            columns: ["household_id"]
            isOneToOne: false
            referencedRelation: "households"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "household_members_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      households: {
        Row: {
          created_at: string
          id: string
          max_members: number
          name: string
          owner_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          max_members?: number
          name: string
          owner_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          max_members?: number
          name?: string
          owner_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "households_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      import_batch_variants: {
        Row: {
          base_url: string | null
          batch_id: string
          created_at: string
          id: string
          model: string
          name: string
          owner_id: string
          prompt: string
          provider: string
          sort_index: number
          updated_at: string
        }
        Insert: {
          base_url?: string | null
          batch_id: string
          created_at?: string
          id?: string
          model: string
          name?: string
          owner_id: string
          prompt: string
          provider: string
          sort_index?: number
          updated_at?: string
        }
        Update: {
          base_url?: string | null
          batch_id?: string
          created_at?: string
          id?: string
          model?: string
          name?: string
          owner_id?: string
          prompt?: string
          provider?: string
          sort_index?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "import_batch_variants_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "import_batches"
            referencedColumns: ["id"]
          },
        ]
      }
      import_batches: {
        Row: {
          batch_kind: string
          created_at: string
          default_model: string
          default_prompt: string | null
          default_provider: string
          fallback_model: string | null
          fallback_provider: string | null
          id: string
          is_planner: boolean
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
          batch_kind?: string
          created_at?: string
          default_model?: string
          default_prompt?: string | null
          default_provider?: string
          fallback_model?: string | null
          fallback_provider?: string | null
          id?: string
          is_planner?: boolean
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
          batch_kind?: string
          created_at?: string
          default_model?: string
          default_prompt?: string | null
          default_provider?: string
          fallback_model?: string | null
          fallback_provider?: string | null
          id?: string
          is_planner?: boolean
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
      import_item_variant_results: {
        Row: {
          attempts: number
          claim_expires_at: string
          claim_token: string | null
          completion_tokens: number | null
          cost_usd_micros: number | null
          created_at: string
          drafts: Json | null
          error_kind: string | null
          error_message: string | null
          id: string
          item_id: string
          latency_ms: number | null
          owner_id: string
          prompt_tokens: number | null
          raw_text: string | null
          status: string
          updated_at: string
          variant_id: string
        }
        Insert: {
          attempts?: number
          claim_expires_at?: string
          claim_token?: string | null
          completion_tokens?: number | null
          cost_usd_micros?: number | null
          created_at?: string
          drafts?: Json | null
          error_kind?: string | null
          error_message?: string | null
          id?: string
          item_id: string
          latency_ms?: number | null
          owner_id: string
          prompt_tokens?: number | null
          raw_text?: string | null
          status?: string
          updated_at?: string
          variant_id: string
        }
        Update: {
          attempts?: number
          claim_expires_at?: string
          claim_token?: string | null
          completion_tokens?: number | null
          cost_usd_micros?: number | null
          created_at?: string
          drafts?: Json | null
          error_kind?: string | null
          error_message?: string | null
          id?: string
          item_id?: string
          latency_ms?: number | null
          owner_id?: string
          prompt_tokens?: number | null
          raw_text?: string | null
          status?: string
          updated_at?: string
          variant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "import_item_variant_results_item_id_fkey"
            columns: ["item_id"]
            isOneToOne: false
            referencedRelation: "import_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "import_item_variant_results_variant_id_fkey"
            columns: ["variant_id"]
            isOneToOne: false
            referencedRelation: "import_batch_variants"
            referencedColumns: ["id"]
          },
        ]
      }
      import_items: {
        Row: {
          assigned_collection_id: string | null
          assigned_page_number: number | null
          assigned_recipe_id: string | null
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
          selected_variant_id: string | null
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
          assigned_recipe_id?: string | null
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
          selected_variant_id?: string | null
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
          assigned_recipe_id?: string | null
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
          selected_variant_id?: string | null
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
            foreignKeyName: "import_items_assigned_recipe_id_fkey"
            columns: ["assigned_recipe_id"]
            isOneToOne: false
            referencedRelation: "recipes"
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
          {
            foreignKeyName: "import_items_selected_variant_fkey"
            columns: ["selected_variant_id"]
            isOneToOne: false
            referencedRelation: "import_batch_variants"
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
          simplified_steps: Json | null
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
          simplified_steps?: Json | null
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
          simplified_steps?: Json | null
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
          model: string
          provider: string
          response_json: Json
        }
        Insert: {
          created_at?: string
          error_kind?: string | null
          item_storage_path: string
          latency_ms?: number
          model?: string
          provider?: string
          response_json?: Json
        }
        Update: {
          created_at?: string
          error_kind?: string | null
          item_storage_path?: string
          latency_ms?: number
          model?: string
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
          tos_accepted_at: string | null
          tos_version: number
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string
          disabled?: boolean
          disabled_reason?: string | null
          display_name?: string | null
          id: string
          tos_accepted_at?: string | null
          tos_version?: number
        }
        Update: {
          avatar_url?: string | null
          created_at?: string
          disabled?: boolean
          disabled_reason?: string | null
          display_name?: string | null
          id?: string
          tos_accepted_at?: string | null
          tos_version?: number
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
          last_share_attestation: string | null
          last_share_attested_at: string | null
          moderation_reason: string | null
          moderation_state: string
          notes: string | null
          owner_id: string
          publication_year: number | null
          publisher: string | null
          shared_with_household_id: string | null
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
          last_share_attestation?: string | null
          last_share_attested_at?: string | null
          moderation_reason?: string | null
          moderation_state?: string
          notes?: string | null
          owner_id: string
          publication_year?: number | null
          publisher?: string | null
          shared_with_household_id?: string | null
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
          last_share_attestation?: string | null
          last_share_attested_at?: string | null
          moderation_reason?: string | null
          moderation_state?: string
          notes?: string | null
          owner_id?: string
          publication_year?: number | null
          publisher?: string | null
          shared_with_household_id?: string | null
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
          {
            foreignKeyName: "recipe_collections_shared_with_household_id_fkey"
            columns: ["shared_with_household_id"]
            isOneToOne: false
            referencedRelation: "households"
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
          starred: boolean
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
          starred?: boolean
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
          starred?: boolean
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
      rewrite_jobs: {
        Row: {
          attempts: number
          claim_expires_at: string
          claim_token: string | null
          completion_tokens: number
          cost_usd_micros: number
          created_at: string
          id: string
          last_error: string | null
          latency_ms: number
          model: string
          owner_id: string
          prompt: string
          prompt_tokens: number
          provider: string
          recipe_id: string
          result_json: Json | null
          status: string
          updated_at: string
        }
        Insert: {
          attempts?: number
          claim_expires_at?: string
          claim_token?: string | null
          completion_tokens?: number
          cost_usd_micros?: number
          created_at?: string
          id?: string
          last_error?: string | null
          latency_ms?: number
          model?: string
          owner_id: string
          prompt?: string
          prompt_tokens?: number
          provider?: string
          recipe_id: string
          result_json?: Json | null
          status?: string
          updated_at?: string
        }
        Update: {
          attempts?: number
          claim_expires_at?: string
          claim_token?: string | null
          completion_tokens?: number
          cost_usd_micros?: number
          created_at?: string
          id?: string
          last_error?: string | null
          latency_ms?: number
          model?: string
          owner_id?: string
          prompt?: string
          prompt_tokens?: number
          provider?: string
          recipe_id?: string
          result_json?: Json | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "rewrite_jobs_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rewrite_jobs_recipe_id_fkey"
            columns: ["recipe_id"]
            isOneToOne: false
            referencedRelation: "recipes"
            referencedColumns: ["id"]
          },
        ]
      }
      rewrite_test_fixtures: {
        Row: {
          created_at: string
          error_kind: string | null
          latency_ms: number
          model: string
          provider: string
          recipe_id: string
          response_json: Json
        }
        Insert: {
          created_at?: string
          error_kind?: string | null
          latency_ms?: number
          model?: string
          provider?: string
          recipe_id?: string
          response_json?: Json
        }
        Update: {
          created_at?: string
          error_kind?: string | null
          latency_ms?: number
          model?: string
          provider?: string
          recipe_id?: string
          response_json?: Json
        }
        Relationships: []
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
      user_ocr_prefs: {
        Row: {
          model: string
          owner_id: string
          prompt: string
          provider: string
          updated_at: string
        }
        Insert: {
          model?: string
          owner_id: string
          prompt?: string
          provider?: string
          updated_at?: string
        }
        Update: {
          model?: string
          owner_id?: string
          prompt?: string
          provider?: string
          updated_at?: string
        }
        Relationships: []
      }
      user_rewrite_prefs: {
        Row: {
          model: string
          owner_id: string
          prompt: string
          provider: string
          updated_at: string
        }
        Insert: {
          model?: string
          owner_id: string
          prompt?: string
          provider?: string
          updated_at?: string
        }
        Update: {
          model?: string
          owner_id?: string
          prompt?: string
          provider?: string
          updated_at?: string
        }
        Relationships: []
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
      accept_household_invite: { Args: { p_token: string }; Returns: string }
      accept_tos: { Args: { p_version: number }; Returns: undefined }
      attest_public_share: {
        Args: { p_attestation: string; p_collection_id: string }
        Returns: undefined
      }
      bakeoff_claim_next: {
        Args: {
          p_lease_seconds?: number
          p_limit?: number
          p_worker_id: string
        }
        Returns: {
          attempts: number
          base_url: string | null
          claim_expires_at: string
          claim_token: string | null
          completion_tokens: number | null
          cost_usd_micros: number | null
          created_at: string
          drafts: Json | null
          error_kind: string | null
          error_message: string | null
          id: string
          latency_ms: number | null
          model: string
          name: string
          owner_id: string
          prompt: string
          prompt_tokens: number | null
          provider: string
          raw_text: string | null
          run_id: string
          sort_index: number
          status: string
          updated_at: string
        }[]
        SetofOptions: {
          from: "*"
          to: "bakeoff_variants"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      bakeoff_complete: {
        Args: { p_claim_token: string; p_result: Json; p_variant_id: string }
        Returns: boolean
      }
      bakeoff_fail: {
        Args: {
          p_claim_token: string
          p_error_kind: string
          p_error_message: string
          p_latency_ms: number
          p_variant_id: string
        }
        Returns: boolean
      }
      bakeoff_promote: { Args: { p_variant_id: string }; Returns: undefined }
      bakeoff_start: {
        Args: {
          p_image_storage_path: string
          p_input_recipe_id?: string
          p_task_kind?: string
          p_variants: Json
        }
        Returns: string
      }
      clear_my_import_storage: {
        Args: { p_id?: string; p_scope: string }
        Returns: string[]
      }
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
      create_household: { Args: { p_name: string }; Returns: string }
      current_household_id: { Args: { p_user_id: string }; Returns: string }
      current_tos_version: { Args: never; Returns: number }
      delete_household: { Args: { p_household_id: string }; Returns: undefined }
      delete_my_account: { Args: never; Returns: undefined }
      fork_collection: {
        Args: { source_collection_id: string }
        Returns: string
      }
      global_conversion_delete: { Args: { p_id: string }; Returns: undefined }
      global_conversion_upsert: {
        Args: {
          p_factor: number
          p_from_unit: string
          p_id?: string
          p_ingredient_name?: string
          p_notes?: string
          p_to_unit: string
        }
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
      house_conversion_delete: { Args: { p_id: string }; Returns: undefined }
      house_conversion_upsert: {
        Args: {
          p_factor: number
          p_from_unit: string
          p_id: string
          p_ingredient_name?: string
          p_notes?: string
          p_to_unit: string
        }
        Returns: string
      }
      household_cooldown_days: { Args: never; Returns: number }
      import_bakeoff_promote: {
        Args: { p_variant_id: string }
        Returns: undefined
      }
      import_bakeoff_seed: {
        Args: { p_batch_id: string; p_variants: Json }
        Returns: undefined
      }
      import_bakeoff_select_winner: {
        Args: { p_item_id: string; p_variant_id: string }
        Returns: undefined
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
          assigned_recipe_id: string | null
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
          selected_variant_id: string | null
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
        Args: { p_batch_id: string; p_model: string; p_provider: string }
        Returns: undefined
      }
      import_set_recitation_policy: {
        Args: { p_batch_id: string; p_policy: string }
        Returns: undefined
      }
      import_variant_claim_next: {
        Args: {
          p_lease_seconds?: number
          p_limit?: number
          p_worker_id: string
        }
        Returns: {
          attempts: number
          claim_expires_at: string
          claim_token: string | null
          completion_tokens: number | null
          cost_usd_micros: number | null
          created_at: string
          drafts: Json | null
          error_kind: string | null
          error_message: string | null
          id: string
          item_id: string
          latency_ms: number | null
          owner_id: string
          prompt_tokens: number | null
          raw_text: string | null
          status: string
          updated_at: string
          variant_id: string
        }[]
        SetofOptions: {
          from: "*"
          to: "import_item_variant_results"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      import_variant_complete: {
        Args: { p_claim_token: string; p_payload: Json; p_result_id: string }
        Returns: boolean
      }
      import_variant_fail: {
        Args: {
          p_claim_token: string
          p_error_kind: string
          p_error_message: string
          p_latency_ms: number
          p_result_id: string
        }
        Returns: boolean
      }
      invite_to_household: { Args: { p_household_id: string }; Returns: string }
      is_admin: { Args: { uid: string }; Returns: boolean }
      is_household_member: {
        Args: { p_household_id: string; p_user_id: string }
        Returns: boolean
      }
      leave_household: { Args: never; Returns: undefined }
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
      preview_household_invite: {
        Args: { p_token: string }
        Returns: {
          expires_at: string
          household_id: string
          household_name: string
          invited_by_name: string
          revoked: boolean
          used: boolean
        }[]
      }
      record_audit: {
        Args: {
          p_action: string
          p_household_id: string
          p_metadata: Json
          p_target_id: string
          p_target_type: string
        }
        Returns: undefined
      }
      remove_household_member: {
        Args: { p_user_id: string }
        Returns: undefined
      }
      rename_household: {
        Args: { p_household_id: string; p_name: string }
        Returns: undefined
      }
      require_current_tos: { Args: never; Returns: undefined }
      revoke_household_invite: {
        Args: { p_invite_id: string }
        Returns: undefined
      }
      rewrite_cancel: { Args: { p_job_id: string }; Returns: boolean }
      rewrite_claim_next: {
        Args: {
          p_lease_seconds?: number
          p_limit?: number
          p_worker_id: string
        }
        Returns: {
          attempts: number
          claim_expires_at: string
          claim_token: string | null
          completion_tokens: number
          cost_usd_micros: number
          created_at: string
          id: string
          last_error: string | null
          latency_ms: number
          model: string
          owner_id: string
          prompt: string
          prompt_tokens: number
          provider: string
          recipe_id: string
          result_json: Json | null
          status: string
          updated_at: string
        }[]
        SetofOptions: {
          from: "*"
          to: "rewrite_jobs"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      rewrite_complete: {
        Args: {
          p_attempt: Json
          p_claim_token: string
          p_job_id: string
          p_result: Json
        }
        Returns: boolean
      }
      rewrite_fail: {
        Args: {
          p_attempt: Json
          p_claim_token: string
          p_job_id: string
          p_next_state: string
        }
        Returns: boolean
      }
      rewrite_kick: { Args: { p_recipe_id?: string }; Returns: undefined }
      rewrite_start: {
        Args: {
          p_model: string
          p_prompt: string
          p_provider: string
          p_recipe_id: string
        }
        Returns: string
      }
      share_collection_with_household: {
        Args: {
          p_attestation: string
          p_collection_id: string
          p_household_id: string
        }
        Returns: undefined
      }
      transfer_household_ownership: {
        Args: { p_new_owner_id: string }
        Returns: undefined
      }
      unshare_collection_from_household: {
        Args: { p_collection_id: string }
        Returns: undefined
      }
      user_ocr_prefs_set: {
        Args: { p_model: string; p_prompt: string; p_provider: string }
        Returns: undefined
      }
      user_rewrite_prefs_set: {
        Args: { p_model: string; p_prompt: string; p_provider: string }
        Returns: undefined
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

