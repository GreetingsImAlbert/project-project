<script lang="ts">
	import { onMount } from 'svelte';
	import { onSwapOrDestroy } from '../lib/island-teardown';
	import { FORUM_MAX_BODY_LENGTH } from '../lib/forum';
	import { toastError } from '../lib/toast.svelte';
	import Avatar from './Avatar.svelte';

	type Author = {
		id: string | null;
		displayName: string;
		avatar: string | null;
	};

	type Reply = {
		id: string;
		body: string;
		createdAt: string;
		author: Author;
		deleted: boolean;
		likeCount: number;
		likedByMe: boolean;
	};

	type Post = {
		id: string;
		body: string;
		createdAt: string;
		author: Author;
		deleted: boolean;
		likeCount: number;
		likedByMe: boolean;
		replies: Reply[];
	};

	let {
		currentUserId,
		currentDisplayName,
		currentAvatar,
	}: {
		currentUserId: string;
		currentDisplayName: string;
		currentAvatar: string | null;
	} = $props();

	let posts = $state<Post[]>([]);
	let nextCursor = $state<string | null>(null);
	let loading = $state(true);
	let loadingMore = $state(false);
	let error = $state<string | null>(null);
	let composerBody = $state('');
	let replyBody = $state('');
	let replyPostId = $state<string | null>(null);
	let posting = $state(false);
	let replying = $state(false);
	let actionKey = $state<string | null>(null);
	let disposed = false;

	function formatDate(value: string): string {
		const date = new Date(value);
		if (Number.isNaN(date.getTime())) return value;
		return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
	}

	async function responseError(response: Response): Promise<Error> {
		const message = await response.text();
		return new Error(message || `Request failed (${response.status})`);
	}

	async function loadFeed(loadMore: boolean) {
		if (loadMore) loadingMore = true;
		else {
			loading = true;
			error = null;
		}

		try {
			const query = loadMore && nextCursor ? `?before=${encodeURIComponent(nextCursor)}` : '';
			const response = await fetch(`/api/forum/feed${query}`);
			if (!response.ok) throw await responseError(response);
			const result = (await response.json()) as { posts: Post[]; nextCursor: string | null };
			if (disposed) return;
			posts = loadMore ? [...posts, ...result.posts] : result.posts;
			nextCursor = result.nextCursor;
		} catch (cause) {
			if (disposed) return;
			error = cause instanceof Error ? cause.message : 'Could not load the forum';
		} finally {
			if (!disposed) {
				loading = false;
				loadingMore = false;
			}
		}
	}

	async function submitPost() {
		if (posting || !composerBody.trim()) return;
		posting = true;
		try {
			const response = await fetch('/api/forum/posts', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ body: composerBody }),
			});
			if (!response.ok) throw await responseError(response);
			composerBody = '';
			await loadFeed(false);
		} catch (cause) {
			toastError(cause instanceof Error ? cause.message : 'Could not create post');
		} finally {
			posting = false;
		}
	}

	function openReply(postId: string) {
		replyPostId = replyPostId === postId ? null : postId;
		replyBody = '';
	}

	async function submitReply(postId: string) {
		if (replying || !replyBody.trim()) return;
		replying = true;
		try {
			const response = await fetch(`/api/forum/posts/${postId}/replies`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ body: replyBody }),
			});
			if (!response.ok) throw await responseError(response);
			replyBody = '';
			replyPostId = null;
			await loadFeed(false);
		} catch (cause) {
			toastError(cause instanceof Error ? cause.message : 'Could not create reply');
		} finally {
			replying = false;
		}
	}

	async function togglePostLike(post: Post) {
		if (post.deleted || actionKey) return;
		actionKey = `post-like-${post.id}`;
		try {
			const response = await fetch(`/api/forum/posts/${post.id}/like`, { method: 'POST' });
			if (!response.ok) throw await responseError(response);
			const result = (await response.json()) as { liked: boolean; likeCount: number };
			posts = posts.map((item) => item.id === post.id ? { ...item, likedByMe: result.liked, likeCount: result.likeCount } : item);
		} catch (cause) {
			toastError(cause instanceof Error ? cause.message : 'Could not update like');
		} finally {
			actionKey = null;
		}
	}

	async function toggleReplyLike(post: Post, reply: Reply) {
		if (post.deleted || reply.deleted || actionKey) return;
		actionKey = `reply-like-${reply.id}`;
		try {
			const response = await fetch(`/api/forum/replies/${reply.id}/like`, { method: 'POST' });
			if (!response.ok) throw await responseError(response);
			const result = (await response.json()) as { liked: boolean; likeCount: number };
			posts = posts.map((item) => item.id !== post.id ? item : {
				...item,
				replies: item.replies.map((itemReply) => itemReply.id === reply.id ? { ...itemReply, likedByMe: result.liked, likeCount: result.likeCount } : itemReply),
			});
		} catch (cause) {
			toastError(cause instanceof Error ? cause.message : 'Could not update like');
		} finally {
			actionKey = null;
		}
	}

	async function deletePost(post: Post) {
		if (post.deleted || actionKey || !window.confirm('Delete this post?')) return;
		actionKey = `post-delete-${post.id}`;
		try {
			const response = await fetch(`/api/forum/posts/${post.id}/delete`, { method: 'POST' });
			if (!response.ok) throw await responseError(response);
			posts = posts.map((item) => item.id === post.id ? { ...item, deleted: true, likedByMe: false, likeCount: 0 } : item);
		} catch (cause) {
			toastError(cause instanceof Error ? cause.message : 'Could not delete post');
		} finally {
			actionKey = null;
		}
	}

	async function deleteReply(post: Post, reply: Reply) {
		if (reply.deleted || actionKey || !window.confirm('Delete this reply?')) return;
		actionKey = `reply-delete-${reply.id}`;
		try {
			const response = await fetch(`/api/forum/replies/${reply.id}/delete`, { method: 'POST' });
			if (!response.ok) throw await responseError(response);
			posts = posts.map((item) => item.id !== post.id ? item : {
				...item,
				replies: item.replies.map((itemReply) => itemReply.id === reply.id ? { ...itemReply, deleted: true, likedByMe: false, likeCount: 0 } : itemReply),
			});
		} catch (cause) {
			toastError(cause instanceof Error ? cause.message : 'Could not delete reply');
		} finally {
			actionKey = null;
		}
	}

	onMount(() => {
		void loadFeed(false);
		return onSwapOrDestroy(() => {
			disposed = true;
		});
	});
</script>

<section class="forum" aria-labelledby="forum-title">
	<header class="forum-header">
		<h1 id="forum-title">Forum</h1>
		<p class="muted">Share thoughts and ideas with everyone on P2.</p>
	</header>

	<form class="composer" onsubmit={(event) => { event.preventDefault(); void submitPost(); }}>
		<div class="composer-author">
			<Avatar avatar={currentAvatar} displayName={currentDisplayName} size={32} />
			<strong>{currentDisplayName || 'You'}</strong>
		</div>
		<textarea
			bind:value={composerBody}
			maxlength={FORUM_MAX_BODY_LENGTH}
			rows="4"
			placeholder="What is on your mind?"
			aria-label="New forum post"
			disabled={posting}
		></textarea>
		<div class="composer-footer">
			<span class="muted character-count">{composerBody.length}/{FORUM_MAX_BODY_LENGTH}</span>
			<button type="submit" disabled={posting || !composerBody.trim()}>{posting ? 'Posting…' : 'Post'}</button>
		</div>
	</form>

	{#if loading}
		<p class="state muted">Loading forum…</p>
	{:else if error && posts.length === 0}
		<div class="state state-error">
			<p>{error}</p>
			<button type="button" class="btn-plain" onclick={() => void loadFeed(false)}>Try again</button>
		</div>
	{:else if posts.length === 0}
		<p class="state muted">No posts yet. Start the conversation.</p>
	{:else}
		<div class="feed">
			{#each posts as post (post.id)}
				<article class:deleted={post.deleted} class="post">
					<div class="author-row">
						<Avatar avatar={post.author.avatar} displayName={post.author.displayName} size={36} />
						<div class="author-meta">
							<strong>{post.author.displayName}</strong>
							<time datetime={post.createdAt} title={formatDate(post.createdAt)}>{formatDate(post.createdAt)}</time>
						</div>
					</div>
					<p class="post-body">{post.deleted ? 'This post was deleted.' : post.body}</p>
					<div class="post-actions">
						<button type="button" class:liked={post.likedByMe} class="btn-plain action-button" disabled={post.deleted || actionKey !== null} onclick={() => void togglePostLike(post)}>
							{post.likedByMe ? 'Liked' : 'Like'} · {post.likeCount}
						</button>
						{#if !post.deleted}
							<button type="button" class="btn-plain action-button" disabled={actionKey !== null} onclick={() => openReply(post.id)}>Reply</button>
						{/if}
						{#if !post.deleted && post.author.id === currentUserId}
							<button type="button" class="btn-plain action-button delete-action" disabled={actionKey !== null} onclick={() => void deletePost(post)}>Delete</button>
						{/if}
					</div>

					{#if replyPostId === post.id && !post.deleted}
						<form class="reply-form" onsubmit={(event) => { event.preventDefault(); void submitReply(post.id); }}>
							<textarea bind:value={replyBody} maxlength={FORUM_MAX_BODY_LENGTH} rows="2" placeholder="Write a reply…" aria-label={`Reply to ${post.author.displayName}`} disabled={replying}></textarea>
							<div class="reply-actions">
								<button type="submit" disabled={replying || !replyBody.trim()}>{replying ? 'Replying…' : 'Reply'}</button>
								<button type="button" class="btn-plain" disabled={replying} onclick={() => openReply(post.id)}>Cancel</button>
							</div>
						</form>
					{/if}

					{#if post.replies.length > 0}
						<div class="replies">
							{#each post.replies as reply (reply.id)}
								<div class:deleted={reply.deleted} class="reply">
									<div class="author-row">
										<Avatar avatar={reply.author.avatar} displayName={reply.author.displayName} size={28} />
										<div class="author-meta">
											<strong>{reply.author.displayName}</strong>
											<time datetime={reply.createdAt} title={formatDate(reply.createdAt)}>{formatDate(reply.createdAt)}</time>
										</div>
									</div>
									<p class="reply-body">{reply.deleted ? 'This reply was deleted.' : reply.body}</p>
									<div class="post-actions">
										<button type="button" class:liked={reply.likedByMe} class="btn-plain action-button" disabled={post.deleted || reply.deleted || actionKey !== null} onclick={() => void toggleReplyLike(post, reply)}>
											{reply.likedByMe ? 'Liked' : 'Like'} · {reply.likeCount}
										</button>
										{#if !reply.deleted && reply.author.id === currentUserId}
											<button type="button" class="btn-plain action-button delete-action" disabled={actionKey !== null} onclick={() => void deleteReply(post, reply)}>Delete</button>
										{/if}
									</div>
								</div>
							{/each}
						</div>
					{/if}
				</article>
			{/each}
		</div>

		{#if error}<p class="inline-error">{error}</p>{/if}
		{#if nextCursor}
			<button type="button" class="load-more btn-plain" disabled={loadingMore} onclick={() => void loadFeed(true)}>
				{loadingMore ? 'Loading…' : 'Load more'}
			</button>
		{/if}
	{/if}
</section>

<style>
	.forum {
		width: min(100%, 760px);
		margin: 0 auto;
	}

	.forum-header {
		margin-bottom: var(--space-6);
	}

	.forum-header h1 {
		margin-bottom: var(--space-2);
	}

	.forum-header p {
		margin: 0;
	}

	.composer {
		display: block;
		border: 1px solid var(--color-border);
		padding: var(--space-4);
		margin-bottom: var(--space-6);
	}

	.composer-author,
	.author-row {
		display: flex;
		align-items: center;
		gap: var(--space-3);
	}

	.composer-author {
		margin-bottom: var(--space-3);
	}

	.composer textarea,
	.reply-form textarea {
		width: 100%;
		box-sizing: border-box;
		resize: vertical;
	}

	.composer-footer,
	.reply-actions {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-2);
		margin-top: var(--space-3);
	}

	.character-count {
		font-size: 0.75rem;
	}

	.feed {
		display: flex;
		flex-direction: column;
	}

	.post {
		border-top: 1px solid var(--color-border);
		padding: var(--space-5) 0;
	}

	.post:last-child {
		border-bottom: 1px solid var(--color-border);
	}

	.author-meta {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}

	.author-meta time {
		color: var(--color-muted);
		font-size: 0.75rem;
	}

	.post-body,
	.reply-body {
		white-space: pre-wrap;
		word-break: break-word;
	}

	.post-body {
		margin: var(--space-4) 0;
	}

	.post-actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
	}

	.action-button {
		padding: var(--space-1) var(--space-2);
		font-size: 0.8rem;
	}

	.action-button.liked {
		color: var(--color-success);
		border-color: var(--color-success);
	}

	.delete-action {
		color: var(--color-danger);
	}

	.reply-form {
		display: block;
		margin: var(--space-4) 0 0;
		padding-left: calc(36px + var(--space-3));
	}

	.reply-actions {
		justify-content: flex-start;
	}

	.replies {
		margin: var(--space-5) 0 0 calc(36px + var(--space-3));
		border-left: 1px solid var(--color-border);
		padding-left: var(--space-4);
	}

	.reply {
		padding: var(--space-3) 0;
	}

	.reply + .reply {
		border-top: 1px solid var(--color-border);
	}

	.reply-body {
		margin: var(--space-3) 0;
	}

	.deleted .post-body,
	.deleted .reply-body {
		color: var(--color-muted);
		font-style: italic;
	}

	.state,
	.inline-error {
		margin: var(--space-6) 0;
	}

	.state-error,
	.inline-error {
		color: var(--color-danger);
	}

	.state-error p {
		margin-bottom: var(--space-3);
	}

	.load-more {
		display: block;
		margin: var(--space-5) auto 0;
	}

	@media (max-width: 640px) {
		.composer {
			padding: var(--space-3);
		}

		.reply-form {
			padding-left: 0;
		}

		.replies {
			margin-left: var(--space-4);
		}
	}
</style>
