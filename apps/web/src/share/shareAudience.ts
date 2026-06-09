// Who can open a recipe's /r/<uuid> share link right now. Pure logic so the
// truth table is unit-testable; the button maps the result to a toast.

export type ShareAudience = 'public' | 'household' | 'private';

export function shareAudience(args: {
  /** collection.isPublic */
  isPublic: boolean;
  /** collection.moderationState === 'TAKEN_DOWN' (clears is_public server-side
   *  too — belt and braces). */
  takenDown: boolean;
  /** in a household AND household_members.library_shared is on */
  libraryShared: boolean;
}): ShareAudience {
  if (args.isPublic && !args.takenDown) return 'public';
  if (args.libraryShared) return 'household';
  return 'private';
}

export const SHARE_AUDIENCE_MESSAGE: Record<ShareAudience, string> = {
  public: 'Link copied — anyone with the link can view (collection is public)',
  household: 'Link copied — only your household can open this link',
  private:
    'Link copied — only you can open this; make the collection public to share it',
};

export const SHARE_AUDIENCE_TONE: Record<ShareAudience, 'success' | 'info' | 'warn'> = {
  public: 'success',
  household: 'info',
  private: 'warn',
};
