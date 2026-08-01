import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './supabase/database.types';

export const FORUM_PAGE_SIZE = 20;
export const FORUM_MAX_BODY_LENGTH = 5_000;
export const FORUM_MAX_REQUEST_BYTES = 100_000;

const FORUM_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FORUM_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;

export type ForumAuthor = {
	id: string | null;
	displayName: string;
	avatar: string | null;
};

export type ForumReply = {
	id: string;
	body: string;
	createdAt: string;
	author: ForumAuthor;
	deleted: boolean;
	likeCount: number;
	likedByMe: boolean;
};

export type ForumPost = {
	id: string;
	body: string;
	createdAt: string;
	author: ForumAuthor;
	deleted: boolean;
	likeCount: number;
	likedByMe: boolean;
	replies: ForumReply[];
};

export type ForumFeed = {
	posts: ForumPost[];
	nextCursor: string | null;
};

type ForumClient = SupabaseClient<Database>;

type PostRow = {
	id: string;
	body: string;
	author_id: string | null;
	created_at: string;
	deleted_at: string | null;
};

type ReplyRow = {
	id: string;
	post_id: string;
	body: string;
	author_id: string | null;
	created_at: string;
	deleted_at: string | null;
};

type ProfileRow = {
	id: string;
	display_name: string;
	avatar: string | null;
};

type PostLikeRow = { post_id: string; user_id: string };
type ReplyLikeRow = { reply_id: string; user_id: string };

function encodeBase64Url(value: string): string {
	return btoa(value).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function decodeBase64Url(value: string): string | null {
	try {
		const padded = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (value.length % 4)) % 4);
		return atob(padded);
	} catch {
		return null;
	}
}

export function encodeForumCursor(createdAt: string, id: string): string {
	return encodeBase64Url(JSON.stringify({ createdAt, id }));
}

export function decodeForumCursor(value: string | null): { createdAt: string; id: string } | null {
	if (!value || value.length > 512) return null;

	const decoded = decodeBase64Url(value);
	if (!decoded) return null;

	try {
		const parsed = JSON.parse(decoded) as { createdAt?: unknown; id?: unknown };
		if (typeof parsed.createdAt !== 'string' || typeof parsed.id !== 'string' || !FORUM_UUID_RE.test(parsed.id)) return null;
		if (!FORUM_TIMESTAMP_RE.test(parsed.createdAt) || !Number.isFinite(Date.parse(parsed.createdAt))) return null;
		return { createdAt: parsed.createdAt, id: parsed.id };
	} catch {
		return null;
	}
}

export function forumBodyProblem(value: unknown): string | null {
	if (typeof value !== 'string') return 'Body is required';
	const body = value.trim();
	if (!body) return 'Body is required';
	if ([...body].length > FORUM_MAX_BODY_LENGTH) return `Body: max ${FORUM_MAX_BODY_LENGTH} characters`;
	return null;
}

export function normalizeForumBody(value: string): string {
	return value.trim();
}

export async function readForumJson(request: Request): Promise<{ value: Record<string, unknown> } | { error: string }> {
	const contentLength = Number(request.headers.get('content-length'));
	if (Number.isFinite(contentLength) && contentLength > FORUM_MAX_REQUEST_BYTES) {
		return { error: 'Request is too large' };
	}

	let text: string;
	try {
		text = await request.text();
	} catch {
		return { error: 'Invalid request body' };
	}

	if (new TextEncoder().encode(text).byteLength > FORUM_MAX_REQUEST_BYTES) return { error: 'Request is too large' };

	try {
		const value: unknown = JSON.parse(text);
		if (!value || typeof value !== 'object' || Array.isArray(value)) return { error: 'Invalid request body' };
		return { value: value as Record<string, unknown> };
	} catch {
		return { error: 'Invalid request body' };
	}
}

function authorFor(authorId: string | null, profiles: Map<string, ProfileRow>): ForumAuthor {
	const profile = authorId ? profiles.get(authorId) : undefined;
	return {
		id: authorId,
		displayName: profile?.display_name ?? 'Former member',
		avatar: profile?.avatar ?? null,
	};
}

export async function readForumFeed(client: ForumClient, userId: string, before: string | null): Promise<ForumFeed | { error: string }> {
	const cursor = before ? decodeForumCursor(before) : null;
	if (before && !cursor) return { error: 'Invalid pagination cursor' };

	let postQuery = client
		.from('forum_posts')
		.select('id, body, author_id, created_at, deleted_at')
		.order('created_at', { ascending: false })
		.order('id', { ascending: false });

	if (cursor) {
		postQuery = postQuery.or(`created_at.lt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.lt.${cursor.id})`);
	}

	const { data: rawPosts, error: postError } = await postQuery
		.limit(FORUM_PAGE_SIZE + 1)
		.overrideTypes<PostRow[]>();

	if (postError) return { error: `Failed to load forum posts: ${postError.message}` };

	const hasMore = (rawPosts?.length ?? 0) > FORUM_PAGE_SIZE;
	const posts = (rawPosts ?? []).slice(0, FORUM_PAGE_SIZE);
	const postIds = posts.map((post) => post.id);

	let replies: ReplyRow[] = [];
	let postLikes: PostLikeRow[] = [];
	let replyLikes: ReplyLikeRow[] = [];

	if (postIds.length > 0) {
		const { data: rawReplies, error: replyError } = await client
			.from('forum_replies')
			.select('id, post_id, body, author_id, created_at, deleted_at')
			.in('post_id', postIds)
			.order('created_at', { ascending: true })
			.order('id', { ascending: true })
			.overrideTypes<ReplyRow[]>();
		if (replyError) return { error: `Failed to load forum replies: ${replyError.message}` };
		replies = rawReplies ?? [];

		const { data: rawPostLikes, error: postLikeError } = await client
			.from('forum_post_likes')
			.select('post_id, user_id')
			.in('post_id', postIds)
			.overrideTypes<PostLikeRow[]>();
		if (postLikeError) return { error: `Failed to load forum likes: ${postLikeError.message}` };
		postLikes = rawPostLikes ?? [];

		const replyIds = replies.map((reply) => reply.id);
		if (replyIds.length > 0) {
			const { data: rawReplyLikes, error: replyLikeError } = await client
				.from('forum_reply_likes')
				.select('reply_id, user_id')
				.in('reply_id', replyIds)
				.overrideTypes<ReplyLikeRow[]>();
			if (replyLikeError) return { error: `Failed to load forum reply likes: ${replyLikeError.message}` };
			replyLikes = rawReplyLikes ?? [];
		}
	}

	const authorIds = [...new Set([...posts.map((post) => post.author_id), ...replies.map((reply) => reply.author_id)].filter((id): id is string => Boolean(id)))];
	const profiles = new Map<string, ProfileRow>();
	if (authorIds.length > 0) {
		// This query is deliberately limited to public profile fields. The feed is global,
		// so it uses the server-side client instead of expanding the profiles RLS policy to
		// disclose private account fields to unrelated users.
		const { data: profileRows, error: profileError } = await client
			.from('profiles')
			.select('id, display_name, avatar')
			.in('id', authorIds)
			.overrideTypes<ProfileRow[]>();
		if (profileError) return { error: `Failed to load forum authors: ${profileError.message}` };
		for (const profile of profileRows ?? []) profiles.set(profile.id, profile);
	}

	const postLikeMap = new Map<string, string[]>();
	for (const like of postLikes) postLikeMap.set(like.post_id, [...(postLikeMap.get(like.post_id) ?? []), like.user_id]);
	const replyLikeMap = new Map<string, string[]>();
	for (const like of replyLikes) replyLikeMap.set(like.reply_id, [...(replyLikeMap.get(like.reply_id) ?? []), like.user_id]);

	const repliesByPost = new Map<string, ForumReply[]>();
	for (const reply of replies) {
		const deleted = reply.deleted_at !== null;
		const likeUsers = replyLikeMap.get(reply.id) ?? [];
		const dto: ForumReply = {
			id: reply.id,
			body: reply.body,
			createdAt: reply.created_at,
			author: authorFor(reply.author_id, profiles),
			deleted,
			likeCount: deleted ? 0 : likeUsers.length,
			likedByMe: !deleted && likeUsers.includes(userId),
		};
		repliesByPost.set(reply.post_id, [...(repliesByPost.get(reply.post_id) ?? []), dto]);
	}

	const serializedPosts: ForumPost[] = posts.map((post) => {
		const deleted = post.deleted_at !== null;
		const likeUsers = postLikeMap.get(post.id) ?? [];
		return {
			id: post.id,
			body: post.body,
			createdAt: post.created_at,
			author: authorFor(post.author_id, profiles),
			deleted,
			likeCount: deleted ? 0 : likeUsers.length,
			likedByMe: !deleted && likeUsers.includes(userId),
			replies: repliesByPost.get(post.id) ?? [],
		};
	});

	return {
		posts: serializedPosts,
		nextCursor: hasMore && posts.length > 0 ? encodeForumCursor(posts[posts.length - 1].created_at, posts[posts.length - 1].id) : null,
	};
}
