import { createContext, useContext } from 'react';
import type { ComponentType, ReactNode } from 'react';

/**
 * Marks the commentable content element. Portal-rendered fragments use it to
 * find their owning message in the DOM (`closest`) without holding a ref,
 * which lets the offset lookup stay a stable, dependency-free callback.
 */
export const COMMENTABLE_CONTENT_ATTRIBUTE = 'data-commentable-content';

/**
 * Published by the commentable-text layer so that message content re-rendered
 * outside its DOM subtree (a modal portal, for example) can still offer the
 * same select-to-comment affordance, anchored to the same message entry.
 *
 * Selection detection is DOM-`contains` based, so a portal cannot reuse the
 * outer container's listeners — it has to mount its own commentable layer.
 * `CommentableFragment` is exactly that, exposed as a component so consumers
 * don't have to import the message-stream module (which would create an import
 * cycle) and so it mounts rather than being called during render.
 */
export interface CommentableTargetValue {
  entryId: string;
  taskId: string;
  CommentableFragment: ComponentType<{
    children: ReactNode;
    /**
     * Offset of the wrapped fragment within the outer content, added to any
     * offset measured inside the portal so stored comments stay comparable.
     */
    charOffsetBase?: () => number;
  }>;
}

const CommentableTargetContext = createContext<CommentableTargetValue | null>(
  null,
);

export const CommentableTargetProvider = CommentableTargetContext.Provider;

export function useCommentableTarget(): CommentableTargetValue | null {
  return useContext(CommentableTargetContext);
}
