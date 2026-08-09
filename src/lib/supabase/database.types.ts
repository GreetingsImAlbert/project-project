export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
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
      bom_items: {
        Row: {
          category: string | null
          created_at: string | null
          deleted_at: string | null
          description: string | null
          id: string
          item_url: string | null
          part_name: string
          project_id: string
          quantity: number | null
          supplier: string | null
          total_cost: number | null
          unit: string | null
          unit_cost: number | null
        }
        Insert: {
          category?: string | null
          created_at?: string | null
          deleted_at?: string | null
          description?: string | null
          id?: string
          item_url?: string | null
          part_name: string
          project_id: string
          quantity?: number | null
          supplier?: string | null
          total_cost?: number | null
          unit?: string | null
          unit_cost?: number | null
        }
        Update: {
          category?: string | null
          created_at?: string | null
          deleted_at?: string | null
          description?: string | null
          id?: string
          item_url?: string | null
          part_name?: string
          project_id?: string
          quantity?: number | null
          supplier?: string | null
          total_cost?: number | null
          unit?: string | null
          unit_cost?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "bom_items_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      error_reports: {
        Row: {
          context: Json | null
          created_at: string
          id: string
          message: string
          method: string | null
          path: string | null
          source: string
          stack: string | null
          url: string | null
          user_id: string | null
        }
        Insert: {
          context?: Json | null
          created_at?: string
          id: string
          message: string
          method?: string | null
          path?: string | null
          source: string
          stack?: string | null
          url?: string | null
          user_id?: string | null
        }
        Update: {
          context?: Json | null
          created_at?: string
          id?: string
          message?: string
          method?: string | null
          path?: string | null
          source?: string
          stack?: string | null
          url?: string | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "error_reports_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      files: {
        Row: {
          created_at: string | null
          deleted_at: string | null
          filename: string
          folder_id: string | null
          id: string
          is_journal: boolean
          is_public: boolean
          mime_type: string | null
          project_id: string
          r2_key: string
          size_bytes: number | null
          storage_provider: string
          uploaded_by: string | null
          uploader_deleted_at: string | null
        }
        Insert: {
          created_at?: string | null
          deleted_at?: string | null
          filename: string
          folder_id?: string | null
          id?: string
          is_journal?: boolean
          is_public?: boolean
          mime_type?: string | null
          project_id: string
          r2_key: string
          size_bytes?: number | null
          storage_provider?: string
          uploaded_by?: string | null
          uploader_deleted_at?: string | null
        }
        Update: {
          created_at?: string | null
          deleted_at?: string | null
          filename?: string
          folder_id?: string | null
          id?: string
          is_journal?: boolean
          is_public?: boolean
          mime_type?: string | null
          project_id?: string
          r2_key?: string
          size_bytes?: number | null
          storage_provider?: string
          uploaded_by?: string | null
          uploader_deleted_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "files_folder_id_fkey"
            columns: ["folder_id"]
            isOneToOne: false
            referencedRelation: "folders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "files_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "files_uploaded_by_fkey"
            columns: ["uploaded_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      folders: {
        Row: {
          created_at: string | null
          deleted_at: string | null
          id: string
          name: string
          parent_folder_id: string | null
          project_id: string
        }
        Insert: {
          created_at?: string | null
          deleted_at?: string | null
          id?: string
          name: string
          parent_folder_id?: string | null
          project_id: string
        }
        Update: {
          created_at?: string | null
          deleted_at?: string | null
          id?: string
          name?: string
          parent_folder_id?: string | null
          project_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "folders_parent_folder_id_fkey"
            columns: ["parent_folder_id"]
            isOneToOne: false
            referencedRelation: "folders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "folders_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      forum_post_likes: {
        Row: {
          created_at: string
          post_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          post_id: string
          user_id: string
        }
        Update: {
          created_at?: string
          post_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "forum_post_likes_post_id_fkey"
            columns: ["post_id"]
            isOneToOne: false
            referencedRelation: "forum_posts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "forum_post_likes_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      forum_posts: {
        Row: {
          author_id: string | null
          body: string
          created_at: string
          deleted_at: string | null
          id: string
        }
        Insert: {
          author_id?: string | null
          body: string
          created_at?: string
          deleted_at?: string | null
          id?: string
        }
        Update: {
          author_id?: string | null
          body?: string
          created_at?: string
          deleted_at?: string | null
          id?: string
        }
        Relationships: [
          {
            foreignKeyName: "forum_posts_author_id_fkey"
            columns: ["author_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      forum_replies: {
        Row: {
          author_id: string | null
          body: string
          created_at: string
          deleted_at: string | null
          id: string
          parent_reply_id: string | null
          post_id: string
        }
        Insert: {
          author_id?: string | null
          body: string
          created_at?: string
          deleted_at?: string | null
          id?: string
          parent_reply_id?: string | null
          post_id: string
        }
        Update: {
          author_id?: string | null
          body?: string
          created_at?: string
          deleted_at?: string | null
          id?: string
          parent_reply_id?: string | null
          post_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "forum_replies_author_id_fkey"
            columns: ["author_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "forum_replies_parent_reply_id_fkey"
            columns: ["parent_reply_id"]
            isOneToOne: false
            referencedRelation: "forum_replies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "forum_replies_post_id_fkey"
            columns: ["post_id"]
            isOneToOne: false
            referencedRelation: "forum_posts"
            referencedColumns: ["id"]
          },
        ]
      }
      forum_reply_likes: {
        Row: {
          created_at: string
          reply_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          reply_id: string
          user_id: string
        }
        Update: {
          created_at?: string
          reply_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "forum_reply_likes_reply_id_fkey"
            columns: ["reply_id"]
            isOneToOne: false
            referencedRelation: "forum_replies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "forum_reply_likes_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      ghost_members: {
        Row: {
          contribution_percent: number | null
          created_at: string | null
          display_name: string
          id: string
          is_deleted_account: boolean
          note: string | null
          project_id: string
        }
        Insert: {
          contribution_percent?: number | null
          created_at?: string | null
          display_name: string
          id?: string
          is_deleted_account?: boolean
          note?: string | null
          project_id: string
        }
        Update: {
          contribution_percent?: number | null
          created_at?: string | null
          display_name?: string
          id?: string
          is_deleted_account?: boolean
          note?: string | null
          project_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ghost_members_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      journal_drafts: {
        Row: {
          content: string
          draft_date: string
          project_id: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          content?: string
          draft_date?: string
          project_id: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          content?: string
          draft_date?: string
          project_id?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "journal_drafts_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: true
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "journal_drafts_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          avatar: string | null
          created_at: string | null
          display_name: string
          email: string | null
          id: string
          is_admin: boolean
          pending_deletion_at: string | null
        }
        Insert: {
          avatar?: string | null
          created_at?: string | null
          display_name: string
          email?: string | null
          id: string
          is_admin?: boolean
          pending_deletion_at?: string | null
        }
        Update: {
          avatar?: string | null
          created_at?: string | null
          display_name?: string
          email?: string | null
          id?: string
          is_admin?: boolean
          pending_deletion_at?: string | null
        }
        Relationships: []
      }
      project_members: {
        Row: {
          contribution_percent: number | null
          is_auditor: boolean
          joined_at: string | null
          project_id: string
          role: string
          user_id: string
        }
        Insert: {
          contribution_percent?: number | null
          is_auditor?: boolean
          joined_at?: string | null
          project_id: string
          role: string
          user_id: string
        }
        Update: {
          contribution_percent?: number | null
          is_auditor?: boolean
          joined_at?: string | null
          project_id?: string
          role?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "project_members_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_members_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      projects: {
        Row: {
          created_at: string | null
          currency: string
          description: string | null
          id: string
          is_public: boolean
          name: string
          owner_id: string
          public_files_enabled: boolean
          updated_at: string | null
        }
        Insert: {
          created_at?: string | null
          currency?: string
          description?: string | null
          id?: string
          is_public?: boolean
          name: string
          owner_id: string
          public_files_enabled?: boolean
          updated_at?: string | null
        }
        Update: {
          created_at?: string | null
          currency?: string
          description?: string | null
          id?: string
          is_public?: boolean
          name?: string
          owner_id?: string
          public_files_enabled?: boolean
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "projects_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      task_assignees: {
        Row: {
          deleted_display_name: string | null
          ghost_member_id: string | null
          id: string
          task_id: string
          user_id: string | null
        }
        Insert: {
          deleted_display_name?: string | null
          ghost_member_id?: string | null
          id?: string
          task_id: string
          user_id?: string | null
        }
        Update: {
          deleted_display_name?: string | null
          ghost_member_id?: string | null
          id?: string
          task_id?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "task_assignees_ghost_member_id_fkey"
            columns: ["ghost_member_id"]
            isOneToOne: false
            referencedRelation: "ghost_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "task_assignees_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "task_assignees_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      task_categories: {
        Row: {
          color_index: number
          name: string
          project_id: string
        }
        Insert: {
          color_index: number
          name: string
          project_id: string
        }
        Update: {
          color_index?: number
          name?: string
          project_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "task_categories_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      task_category_positions: {
        Row: {
          category_name: string | null
          created_at: string
          id: string
          priority_position: number
          project_id: string
        }
        Insert: {
          category_name?: string | null
          created_at?: string
          id?: string
          priority_position?: number
          project_id: string
        }
        Update: {
          category_name?: string | null
          created_at?: string
          id?: string
          priority_position?: number
          project_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "task_category_positions_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      tasks: {
        Row: {
          category: string | null
          created_at: string | null
          deadline: string | null
          deadline_time: string
          deleted_at: string | null
          description: string | null
          id: string
          name: string
          priority_position: number
          project_id: string
          start_date: string | null
          start_time: string
          status: string
        }
        Insert: {
          category?: string | null
          created_at?: string | null
          deadline?: string | null
          deadline_time?: string
          deleted_at?: string | null
          description?: string | null
          id?: string
          name: string
          priority_position?: number
          project_id: string
          start_date?: string | null
          start_time?: string
          status?: string
        }
        Update: {
          category?: string | null
          created_at?: string | null
          deadline?: string | null
          deadline_time?: string
          deleted_at?: string | null
          description?: string | null
          id?: string
          name?: string
          priority_position?: number
          project_id?: string
          start_date?: string | null
          start_time?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "tasks_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      transactions: {
        Row: {
          created_at: string | null
          deleted_at: string | null
          ghost_member_id: string | null
          group_id: string | null
          id: string
          item_name: string | null
          item_url: string | null
          member_id: string | null
          project_id: string
          quantity: number | null
          related_ghost_member_id: string | null
          related_member_id: string | null
          supplier: string | null
          total_cost: number | null
          transaction_date: string
          type: string
          unit: string | null
          unit_cost: number | null
        }
        Insert: {
          created_at?: string | null
          deleted_at?: string | null
          ghost_member_id?: string | null
          group_id?: string | null
          id?: string
          item_name?: string | null
          item_url?: string | null
          member_id?: string | null
          project_id: string
          quantity?: number | null
          related_ghost_member_id?: string | null
          related_member_id?: string | null
          supplier?: string | null
          total_cost?: number | null
          transaction_date: string
          type: string
          unit?: string | null
          unit_cost?: number | null
        }
        Update: {
          created_at?: string | null
          deleted_at?: string | null
          ghost_member_id?: string | null
          group_id?: string | null
          id?: string
          item_name?: string | null
          item_url?: string | null
          member_id?: string | null
          project_id?: string
          quantity?: number | null
          related_ghost_member_id?: string | null
          related_member_id?: string | null
          supplier?: string | null
          total_cost?: number | null
          transaction_date?: string
          type?: string
          unit?: string | null
          unit_cost?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "transactions_ghost_member_id_fkey"
            columns: ["ghost_member_id"]
            isOneToOne: false
            referencedRelation: "ghost_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "transactions_group_id_fkey"
            columns: ["group_id"]
            isOneToOne: false
            referencedRelation: "transactions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "transactions_member_id_fkey"
            columns: ["member_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "transactions_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "transactions_related_ghost_member_id_fkey"
            columns: ["related_ghost_member_id"]
            isOneToOne: false
            referencedRelation: "ghost_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "transactions_related_member_id_fkey"
            columns: ["related_member_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      can_edit_money: { Args: { check_project_id: string }; Returns: boolean }
      create_bulk_transaction_with_lines: {
        Args: {
          p_ghost_member_id: string
          p_item_url: string
          p_label: string
          p_lines: Json
          p_member_id: string
          p_project_id: string
          p_supplier: string
          p_total: number
          p_transaction_date: string
        }
        Returns: string
      }
      create_task_with_assignees: {
        Args: {
          p_category: string
          p_deadline: string
          p_deadline_time: string
          p_description: string
          p_ghost_member_ids: string[]
          p_name: string
          p_project_id: string
          p_start_date: string
          p_start_time: string
          p_status: string
          p_user_ids: string[]
        }
        Returns: string
      }
      global_storage_breakdown: {
        Args: never
        Returns: {
          project_id: string
          total_bytes: number
          uploaded_by: string
        }[]
      }
      global_storage_bytes: { Args: never; Returns: number }
      is_project_member: {
        Args: { check_project_id: string }
        Returns: boolean
      }
      project_role: { Args: { check_project_id: string }; Returns: string }
      project_storage_bytes: {
        Args: { check_project_id: string }
        Returns: number
      }
      public_project_get: {
        Args: { p_id: string }
        Returns: {
          description: string
          id: string
          is_public: boolean
          name: string
          public_files_enabled: boolean
        }[]
      }
      public_project_list: {
        Args: never
        Returns: {
          description: string
          id: string
          name: string
        }[]
      }
      replace_bulk_transaction_with_lines: {
        Args: {
          p_ghost_member_id: string
          p_item_url: string
          p_label: string
          p_lines: Json
          p_member_id: string
          p_supplier: string
          p_total: number
          p_transaction_date: string
          p_transaction_id: string
        }
        Returns: undefined
      }
      set_transaction_deleted: {
        Args: { p_deleted_at: string; p_transaction_id: string }
        Returns: undefined
      }
      shares_project_with: {
        Args: { target_user_id: string }
        Returns: boolean
      }
      soft_delete_folder_tree: {
        Args: {
          p_deleted_at: string
          p_folder_id: string
          p_project_id: string
        }
        Returns: undefined
      }
      task_project_id: { Args: { check_task_id: string }; Returns: string }
      update_task_with_assignees: {
        Args: {
          p_category: string
          p_deadline: string
          p_deadline_time: string
          p_description: string
          p_ghost_member_ids: string[]
          p_kept_deleted_assignee_ids: string[]
          p_name: string
          p_start_date: string
          p_start_time: string
          p_status: string
          p_task_id: string
          p_user_ids: string[]
        }
        Returns: undefined
      }
      user_storage_bytes: {
        Args: { target_user_id: string }
        Returns: {
          row_count: number
          total_bytes: number
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
