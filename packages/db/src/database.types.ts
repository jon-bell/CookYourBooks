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
      ingredients: {
        Row: {
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
          ingredient_id: string
          instruction_id: string
        }
        Insert: {
          ingredient_id: string
          instruction_id: string
        }
        Update: {
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
          recipe_id: string
          step_number: number
          text: string
        }
        Insert: {
          id?: string
          recipe_id: string
          step_number: number
          text: string
        }
        Update: {
          id?: string
          recipe_id?: string
          step_number?: number
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
          collection_id: string
          created_at: string
          id: string
          notes: string | null
          parent_recipe_id: string | null
          servings_amount: number | null
          servings_description: string | null
          sort_order: number
          title: string
          updated_at: string
        }
        Insert: {
          collection_id: string
          created_at?: string
          id?: string
          notes?: string | null
          parent_recipe_id?: string | null
          servings_amount?: number | null
          servings_description?: string | null
          sort_order?: number
          title: string
          updated_at?: string
        }
        Update: {
          collection_id?: string
          created_at?: string
          id?: string
          notes?: string | null
          parent_recipe_id?: string | null
          servings_amount?: number | null
          servings_description?: string | null
          sort_order?: number
          title?: string
          updated_at?: string
        }
        Relationships: [
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
    }
    Views: {
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
      cli_export_library: { Args: { raw_token: string }; Returns: Json }
      cli_import_recipe: {
        Args: { raw_token: string; recipe: Json; target_collection_id: string }
        Returns: string
      }
      cli_issue_token: { Args: { token_name: string }; Returns: string }
      cli_verify_token: { Args: { raw_token: string }; Returns: string }
      fork_collection: {
        Args: { source_collection_id: string }
        Returns: string
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

