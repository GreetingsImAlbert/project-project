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
		parentReplyId: string | null;
		body: string;
		createdAt: string;
		author: Author;
		deleted: boolean;
		likeCount: number;
		likedByMe: boolean;
		children: Reply[];
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

	type PendingContent = {
		body: string;
		createdAt: string;
		author: Author;
	};

	type PendingReply = PendingContent & {
		postId: string;
		parentReplyId: string | null;
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
	let composerExpanded = $state(false);
	let replyDrafts = $state<Record<string, string>>({});
	let posting = $state(false);
	let replying = $state(false);
	let pendingPost = $state<PendingContent | null>(null);
	let pendingReply = $state<PendingReply | null>(null);
	let actionKeys = $state<Record<string, true>>({});
	let expandedPostIds = $state<Record<string, true>>({});
	let expandedReplyIds = $state<Record<string, true>>({});
	let openMenuId = $state<string | null>(null);
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

	function isActionPending(key: string): boolean {
		return Boolean(actionKeys[key]);
	}

	function setActionPending(key: string, pending: boolean) {
		const next = { ...actionKeys };
		if (pending) next[key] = true;
		else delete next[key];
		actionKeys = next;
	}

	function isPostRepliesExpanded(postId: string): boolean {
		return Boolean(expandedPostIds[postId]);
	}

	function isReplyRepliesExpanded(replyId: string): boolean {
		return Boolean(expandedReplyIds[replyId]);
	}

	function replyKey(postId: string, parentReplyId: string | null): string {
		return `${postId}:${parentReplyId ?? 'root'}`;
	}

	function getReplyDraft(postId: string, parentReplyId: string | null): string {
		return replyDrafts[replyKey(postId, parentReplyId)] ?? '';
	}

	function setReplyDraft(postId: string, parentReplyId: string | null, body: string) {
		replyDrafts = { ...replyDrafts, [replyKey(postId, parentReplyId)]: body };
	}

	function clearReplyDraft(postId: string, parentReplyId: string | null) {
		const next = { ...replyDrafts };
		delete next[replyKey(postId, parentReplyId)];
		replyDrafts = next;
	}

	function setRepliesExpanded(postId: string, parentReplyId: string | null, expanded: boolean) {
		if (parentReplyId === null) {
			const next = { ...expandedPostIds };
			if (expanded) next[postId] = true;
			else delete next[postId];
			expandedPostIds = next;
			return;
		}

		const next = { ...expandedReplyIds };
		if (expanded) next[parentReplyId] = true;
		else delete next[parentReplyId];
		expandedReplyIds = next;
	}

	function toggleReplies(postId: string, parentReplyId: string | null) {
		if (replying) return;
		const expanded = parentReplyId === null ? isPostRepliesExpanded(postId) : isReplyRepliesExpanded(parentReplyId);
		setRepliesExpanded(postId, parentReplyId, !expanded);
		closeMenu();
	}

	function handleReplyInput(event: Event, postId: string, parentReplyId: string | null) {
		const target = event.currentTarget;
		if (target instanceof HTMLTextAreaElement) setReplyDraft(postId, parentReplyId, target.value);
	}

	function menuKey(type: 'post' | 'reply', id: string): string {
		return `${type}:${id}`;
	}

	function isMenuOpen(type: 'post' | 'reply', id: string): boolean {
		return openMenuId === menuKey(type, id);
	}

	function toggleMenu(type: 'post' | 'reply', id: string) {
		const key = menuKey(type, id);
		openMenuId = openMenuId === key ? null : key;
	}

	function closeMenu() {
		openMenuId = null;
	}

	function handleWindowClick(event: MouseEvent) {
		const target = event.target;
		if (target instanceof Element && target.closest('.more-menu-wrap')) return;
		closeMenu();
	}

	function handleWindowKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape') closeMenu();
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
			error = cause instanceof Error ? cause.message : 'Could not load the workshop';
		} finally {
			if (!disposed) {
				loading = false;
				loadingMore = false;
			}
		}
	}

	async function submitPost() {
		const body = composerBody.trim();
		if (posting || !body) return;
		const pending = {
			body,
			createdAt: new Date().toISOString(),
			author: { id: currentUserId, displayName: currentDisplayName || 'You', avatar: currentAvatar },
		};
		pendingPost = pending;
		composerBody = '';
		composerExpanded = false;
		posting = true;
		try {
			const response = await fetch('/api/forum/posts', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ body }),
			});
			if (!response.ok) throw await responseError(response);
			const result = (await response.json()) as { id: string; createdAt?: string };
			posts = [{
				id: result.id,
				body: pending.body,
				createdAt: result.createdAt ?? pending.createdAt,
				author: pending.author,
				deleted: false,
				likeCount: 0,
				likedByMe: false,
				replies: [],
			}, ...posts];
			pendingPost = null;
		} catch (cause) {
			composerBody = body;
			composerExpanded = true;
			pendingPost = null;
			toastError(cause instanceof Error ? cause.message : 'Could not create post');
		} finally {
			posting = false;
		}
	}

	function appendReply(replies: Reply[], reply: Reply): Reply[] {
		if (reply.parentReplyId === null) return [...replies, reply];

		let changed = false;
		const next = replies.map((item) => {
			if (item.id === reply.parentReplyId) {
				changed = true;
				return { ...item, children: [...item.children, reply] };
			}
			if (item.children.length === 0) return item;
			const children = appendReply(item.children, reply);
			if (children === item.children) return item;
			changed = true;
			return { ...item, children };
		});
		return changed ? next : replies;
	}

	function updateReplyTree(replies: Reply[], replyId: string, update: (reply: Reply) => Reply): Reply[] {
		let changed = false;
		const next = replies.map((item) => {
			if (item.id === replyId) {
				changed = true;
				return update(item);
			}
			if (item.children.length === 0) return item;
			const children = updateReplyTree(item.children, replyId, update);
			if (children === item.children) return item;
			changed = true;
			return { ...item, children };
		});
		return changed ? next : replies;
	}

	function updatePostReply(post: Post, replyId: string, update: (reply: Reply) => Reply): Post {
		const replies = updateReplyTree(post.replies, replyId, update);
		return replies === post.replies ? post : { ...post, replies };
	}

	async function submitReply(postId: string, parentReplyId: string | null) {
		const body = getReplyDraft(postId, parentReplyId).trim();
		if (replying || !body) return;
		const pending = {
			postId,
			parentReplyId,
			body,
			createdAt: new Date().toISOString(),
			author: { id: currentUserId, displayName: currentDisplayName || 'You', avatar: currentAvatar },
		};
		pendingReply = pending;
		clearReplyDraft(postId, parentReplyId);
		replying = true;
		try {
			const response = await fetch(`/api/forum/posts/${postId}/replies`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ body, parentReplyId }),
			});
			if (!response.ok) throw await responseError(response);
			const result = (await response.json()) as { id: string; parentReplyId?: string | null; createdAt?: string };
			posts = posts.map((post) => post.id !== postId ? post : {
				...post,
				replies: appendReply(post.replies, {
					id: result.id,
					parentReplyId: result.parentReplyId ?? parentReplyId,
					body: pending.body,
					createdAt: result.createdAt ?? pending.createdAt,
					author: pending.author,
					deleted: false,
					likeCount: 0,
					likedByMe: false,
					children: [],
				}),
			});
			pendingReply = null;
		} catch (cause) {
			setReplyDraft(postId, parentReplyId, body);
			pendingReply = null;
			toastError(cause instanceof Error ? cause.message : 'Could not create reply');
		} finally {
			replying = false;
		}
	}

	async function togglePostLike(post: Post) {
		const actionKey = `post-like-${post.id}`;
		if (post.deleted || isActionPending(actionKey)) return;
		const optimisticLiked = !post.likedByMe;
		// The label/colour is local feedback and should not wait on the network. Keep
		// the count untouched until the server confirms the like mutation below.
		posts = posts.map((item) => item.id === post.id ? { ...item, likedByMe: optimisticLiked } : item);
		setActionPending(actionKey, true);
		try {
			const response = await fetch(`/api/forum/posts/${post.id}/like`, { method: 'POST' });
			if (!response.ok) throw await responseError(response);
			const result = (await response.json()) as { liked: boolean; likeCount: number };
			posts = posts.map((item) => item.id === post.id ? { ...item, likedByMe: result.liked, likeCount: result.likeCount } : item);
		} catch (cause) {
			posts = posts.map((item) => item.id === post.id ? { ...item, likedByMe: post.likedByMe } : item);
			toastError(cause instanceof Error ? cause.message : 'Could not update like');
		} finally {
			setActionPending(actionKey, false);
		}
	}

	async function toggleReplyLike(post: Post, reply: Reply) {
		const actionKey = `reply-like-${reply.id}`;
		if (post.deleted || reply.deleted || isActionPending(actionKey)) return;
		const optimisticLiked = !reply.likedByMe;
		// The like icon gets the same immediate feedback; only its count waits for
		// the server response.
		posts = posts.map((item) => item.id !== post.id ? item : updatePostReply(item, reply.id, (itemReply) => ({ ...itemReply, likedByMe: optimisticLiked })));
		setActionPending(actionKey, true);
		try {
			const response = await fetch(`/api/forum/replies/${reply.id}/like`, { method: 'POST' });
			if (!response.ok) throw await responseError(response);
			const result = (await response.json()) as { liked: boolean; likeCount: number };
			posts = posts.map((item) => item.id !== post.id ? item : updatePostReply(item, reply.id, (itemReply) => ({ ...itemReply, likedByMe: result.liked, likeCount: result.likeCount })));
		} catch (cause) {
			posts = posts.map((item) => item.id !== post.id ? item : updatePostReply(item, reply.id, (itemReply) => ({ ...itemReply, likedByMe: reply.likedByMe })));
			toastError(cause instanceof Error ? cause.message : 'Could not update like');
		} finally {
			setActionPending(actionKey, false);
		}
	}

	async function deletePost(post: Post) {
		const actionKey = `post-delete-${post.id}`;
		if (post.deleted || isActionPending(actionKey) || !window.confirm('Delete this post?')) return;
		setActionPending(actionKey, true);
		try {
			const response = await fetch(`/api/forum/posts/${post.id}/delete`, { method: 'POST' });
			if (!response.ok) throw await responseError(response);
			posts = posts.map((item) => item.id === post.id ? { ...item, deleted: true, likedByMe: false, likeCount: 0 } : item);
		} catch (cause) {
			toastError(cause instanceof Error ? cause.message : 'Could not delete post');
		} finally {
			setActionPending(actionKey, false);
		}
	}

	async function deleteReply(post: Post, reply: Reply) {
		const actionKey = `reply-delete-${reply.id}`;
		if (reply.deleted || isActionPending(actionKey) || !window.confirm('Delete this reply?')) return;
		setActionPending(actionKey, true);
		try {
			const response = await fetch(`/api/forum/replies/${reply.id}/delete`, { method: 'POST' });
			if (!response.ok) throw await responseError(response);
			posts = posts.map((item) => item.id !== post.id ? item : updatePostReply(item, reply.id, (itemReply) => ({ ...itemReply, deleted: true, likedByMe: false, likeCount: 0 })));
		} catch (cause) {
			toastError(cause instanceof Error ? cause.message : 'Could not delete reply');
		} finally {
			setActionPending(actionKey, false);
		}
	}

	onMount(() => {
		void loadFeed(false);
		return onSwapOrDestroy(() => {
			disposed = true;
		});
	});
</script>

<svelte:window onclick={handleWindowClick} onkeydown={handleWindowKeydown} />

{#snippet likeIcon()}
	<svg class="action-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
		<path d="M7.5 10.5v9.5H4v-9.5h3.5Z" />
		<path d="M7.5 10.5h2.1l2.8-5.6a1.5 1.5 0 0 1 2.8.9l-.7 4.7h4a2 2 0 0 1 1.9 2.6l-1.8 5.4a2.7 2.7 0 0 1-2.6 1.9H7.5" />
	</svg>
{/snippet}

{#snippet replyIcon()}
	<svg class="action-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
		<path d="M20 11.5a7.5 7.5 0 0 1-7.5 7.5H7l-4 2v-4.6a7.5 7.5 0 1 1 17-4.9Z" />
	</svg>
{/snippet}

{#snippet replyComposer(postId: string, parentReplyId: string | null, label: string)}
	<form class="reply-form" onsubmit={(event) => { event.preventDefault(); void submitReply(postId, parentReplyId); }}>
		<textarea
			value={getReplyDraft(postId, parentReplyId)}
			oninput={(event) => handleReplyInput(event, postId, parentReplyId)}
			maxlength={FORUM_MAX_BODY_LENGTH}
			rows="2"
			placeholder="Write a reply…"
			aria-label={label}
			disabled={replying}
		></textarea>
		<div class="reply-actions">
			<button type="submit" disabled={replying || !getReplyDraft(postId, parentReplyId).trim()}>{replying ? 'Replying…' : 'Reply'}</button>
		</div>
	</form>
{/snippet}

{#snippet pendingReplyView(pending: PendingReply)}
	<div class="reply pending-reply" aria-busy="true">
		<div class="author-row">
			<Avatar avatar={pending.author.avatar} displayName={pending.author.displayName} size={24} />
			<div class="author-meta">
				<strong>{pending.author.displayName}</strong>
				<span class="pending-status"><span class="spinner" aria-hidden="true"></span> Replying…</span>
			</div>
		</div>
		<p class="reply-body">{pending.body}</p>
	</div>
{/snippet}

	{#snippet renderReply(post: Post, reply: Reply)}
	<div class="reply-node">
		<div class:deleted={reply.deleted} class="reply">
			{#if !post.deleted && !reply.deleted && reply.author.id === currentUserId}
				<div class="more-menu-wrap">
					<button
						type="button"
						class="more-button"
						aria-label="More reply actions"
						aria-haspopup="menu"
						aria-expanded={isMenuOpen('reply', reply.id)}
						onclick={(event) => { event.stopPropagation(); toggleMenu('reply', reply.id); }}
					>
						<span aria-hidden="true">⋮</span>
					</button>
					{#if isMenuOpen('reply', reply.id)}
						<div class="more-menu" role="menu" tabindex="-1">
							<button
								type="button"
								class="delete-action"
								role="menuitem"
								disabled={isActionPending(`reply-delete-${reply.id}`)}
								onclick={() => { closeMenu(); void deleteReply(post, reply); }}
							>
								Delete
							</button>
						</div>
					{/if}
				</div>
			{/if}
			<div class="author-row">
				<Avatar avatar={reply.author.avatar} displayName={reply.author.displayName} size={24} />
				<div class="author-meta">
					<strong>{reply.author.displayName}</strong>
					<time datetime={reply.createdAt} title={formatDate(reply.createdAt)}>{formatDate(reply.createdAt)}</time>
				</div>
			</div>
			<p class="reply-body">{reply.deleted ? 'This reply was deleted.' : reply.body}</p>
			<div class="post-actions">
				<button
					type="button"
					class:liked={reply.likedByMe}
					class:like-pending={isActionPending(`reply-like-${reply.id}`)}
					class="icon-action"
					aria-label={reply.likedByMe ? `Unlike reply (${reply.likeCount})` : `Like reply (${reply.likeCount})`}
					title={reply.likedByMe ? 'Unlike reply' : 'Like reply'}
					disabled={post.deleted || reply.deleted || isActionPending(`reply-like-${reply.id}`)}
					onclick={() => void toggleReplyLike(post, reply)}
				>
					{@render likeIcon()}
					<span class="action-count" aria-hidden="true">{reply.likeCount}</span>
				</button>
				{#if !post.deleted && !reply.deleted}
					<button
						type="button"
						class="icon-action"
						aria-label={isReplyRepliesExpanded(reply.id) ? 'Hide replies' : 'Show replies'}
						title={isReplyRepliesExpanded(reply.id) ? 'Hide replies' : 'Show replies'}
						aria-expanded={isReplyRepliesExpanded(reply.id)}
						disabled={replying}
						onclick={() => toggleReplies(post.id, reply.id)}
					>
						{@render replyIcon()}
					</button>
				{/if}
			</div>
		</div>

		{#if !post.deleted && !reply.deleted && isReplyRepliesExpanded(reply.id)}
			{@render replyComposer(post.id, reply.id, `Reply to ${reply.author.displayName}`)}
		{/if}

		{#if isReplyRepliesExpanded(reply.id) && (reply.children.length > 0 || (pendingReply?.postId === post.id && pendingReply.parentReplyId === reply.id))}
			<div class="reply-children">
				{#if pendingReply && pendingReply.postId === post.id && pendingReply.parentReplyId === reply.id}
					{@render pendingReplyView(pendingReply)}
				{/if}
				{#each reply.children as child (child.id)}
					{@render renderReply(post, child)}
				{/each}
			</div>
		{/if}
	</div>
{/snippet}

<section class="forum" aria-labelledby="workshop-title">
	<header class="forum-header">
		<h1 id="workshop-title">Workshop</h1>
		<p class="muted">Share thoughts and ideas with everyone on P2.</p>
	</header>

	<form class:expanded={composerExpanded} class="composer" onsubmit={(event) => { event.preventDefault(); void submitPost(); }}>
		{#if !composerExpanded}
			<button type="button" class="composer-trigger" onclick={() => composerExpanded = true}>What are you building?</button>
		{:else}
			<textarea
				bind:value={composerBody}
				maxlength={FORUM_MAX_BODY_LENGTH}
				rows="3"
				placeholder="What are you building?"
				aria-label="New workshop post"
				autofocus
				disabled={posting}
			></textarea>
			<div class="composer-footer">
				<span class="muted character-count">{composerBody.length}/{FORUM_MAX_BODY_LENGTH}</span>
				<div class="composer-actions">
					<button type="button" class="btn-plain" disabled={posting} onclick={() => { composerBody = ''; composerExpanded = false; }}>Cancel</button>
					<button type="submit" disabled={posting || !composerBody.trim()}>{posting ? 'Posting…' : 'Post'}</button>
				</div>
			</div>
		{/if}
	</form>

	{#if pendingPost}
		<article class="post pending-post" aria-busy="true">
			<div class="author-row">
				<Avatar avatar={pendingPost.author.avatar} displayName={pendingPost.author.displayName} size={32} />
				<div class="author-meta">
					<strong>{pendingPost.author.displayName}</strong>
					<span class="pending-status"><span class="spinner" aria-hidden="true"></span> Posting…</span>
				</div>
			</div>
			<p class="post-body">{pendingPost.body}</p>
		</article>
	{/if}

	{#if loading}
		<p class="state muted">Loading workshop…</p>
	{:else if error && posts.length === 0}
		<div class="state state-error">
			<p>{error}</p>
			<button type="button" class="btn-plain" onclick={() => void loadFeed(false)}>Try again</button>
		</div>
	{:else if posts.length === 0 && !pendingPost}
		<p class="state muted">No posts yet. Start the conversation.</p>
	{:else}
		<div class="feed">
			{#each posts as post (post.id)}
				<article class:deleted={post.deleted} class="post">
					{#if !post.deleted && post.author.id === currentUserId}
						<div class="more-menu-wrap">
							<button
								type="button"
								class="more-button"
								aria-label="More post actions"
								aria-haspopup="menu"
								aria-expanded={isMenuOpen('post', post.id)}
								onclick={(event) => { event.stopPropagation(); toggleMenu('post', post.id); }}
							>
								<span aria-hidden="true">⋮</span>
							</button>
							{#if isMenuOpen('post', post.id)}
								<div class="more-menu" role="menu" tabindex="-1">
									<button
										type="button"
										class="delete-action"
										role="menuitem"
										disabled={isActionPending(`post-delete-${post.id}`)}
										onclick={() => { closeMenu(); void deletePost(post); }}
									>
										Delete
									</button>
								</div>
							{/if}
						</div>
					{/if}
					<div class="author-row">
						<Avatar avatar={post.author.avatar} displayName={post.author.displayName} size={32} />
						<div class="author-meta">
							<strong>{post.author.displayName}</strong>
							<time datetime={post.createdAt} title={formatDate(post.createdAt)}>{formatDate(post.createdAt)}</time>
						</div>
					</div>
					<p class="post-body">{post.deleted ? 'This post was deleted.' : post.body}</p>
					<div class="post-actions">
						<button
							type="button"
							class:liked={post.likedByMe}
							class:like-pending={isActionPending(`post-like-${post.id}`)}
							class="icon-action"
							aria-label={post.likedByMe ? `Unlike post (${post.likeCount})` : `Like post (${post.likeCount})`}
							title={post.likedByMe ? 'Unlike post' : 'Like post'}
							disabled={post.deleted || isActionPending(`post-like-${post.id}`)}
							onclick={() => void togglePostLike(post)}
						>
							{@render likeIcon()}
							<span class="action-count" aria-hidden="true">{post.likeCount}</span>
						</button>
						{#if !post.deleted}
							<button
								type="button"
								class="icon-action"
								aria-label={isPostRepliesExpanded(post.id) ? 'Hide replies' : 'Show replies'}
								title={isPostRepliesExpanded(post.id) ? 'Hide replies' : 'Show replies'}
								aria-expanded={isPostRepliesExpanded(post.id)}
								disabled={replying}
								onclick={() => toggleReplies(post.id, null)}
							>
								{@render replyIcon()}
							</button>
						{/if}
					</div>

					{#if !post.deleted && isPostRepliesExpanded(post.id)}
						{@render replyComposer(post.id, null, `Reply to ${post.author.displayName}`)}
					{/if}

					{#if isPostRepliesExpanded(post.id) && (post.replies.length > 0 || (pendingReply?.postId === post.id && pendingReply.parentReplyId === null))}
						<div class="replies">
							{#if pendingReply && pendingReply.postId === post.id && pendingReply.parentReplyId === null}
								{@render pendingReplyView(pendingReply)}
							{/if}
							{#each post.replies as reply (reply.id)}
								{@render renderReply(post, reply)}
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
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: var(--space-3);
		flex-wrap: wrap;
		margin-bottom: var(--space-3);
		padding-bottom: var(--space-3);
		border-bottom: 1px solid var(--color-border);
	}

	.forum-header h1 {
		font-size: 1.35rem;
		margin-bottom: 0;
	}

	.forum-header p {
		margin: 0;
		font-size: 0.82rem;
	}

	.composer {
		display: block;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
		background: var(--color-surface-inset);
		padding: 4px;
		margin-bottom: var(--space-3);
		transition: border-color 0.15s ease, background-color 0.15s ease;
	}

	.composer:focus-within {
		border-color: var(--color-border-strong);
		background: var(--color-surface-raised);
	}

	.author-row {
		display: flex;
		align-items: center;
		gap: var(--space-2);
	}

	.composer.expanded {
		padding: var(--space-3);
		background: var(--color-surface-raised);
	}

	.composer-trigger {
		width: 100%;
		border: 0;
		background: transparent;
		color: var(--color-muted);
		padding: 7px var(--space-3);
		border-radius: var(--radius-sm);
		text-align: left;
		cursor: text;
		font-size: 0.88rem;
	}

	.composer-trigger:hover {
		color: var(--color-fg);
		background: var(--color-highlight);
	}

	.composer textarea,
	.reply-form textarea {
		width: 100%;
		box-sizing: border-box;
		min-height: 72px;
		resize: vertical;
	}

	.composer-footer,
	.reply-actions {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-2);
		margin-top: var(--space-2);
	}

	.composer-actions {
		display: flex;
		align-items: center;
		gap: var(--space-1);
	}

	.composer-actions button,
	.reply-actions button {
		padding: var(--space-1) var(--space-3);
		font-size: 0.78rem;
	}

	.character-count {
		font-size: 0.75rem;
	}

	.feed {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
	}

	.post {
		position: relative;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
		background: var(--color-surface-raised);
		padding: var(--space-3) calc(var(--space-4) + 1.5rem) var(--space-3) var(--space-4);
		transition: border-color 0.15s ease, background-color 0.15s ease;
	}

	.more-menu-wrap {
		position: absolute;
		top: var(--space-2);
		right: var(--space-2);
		z-index: 2;
	}

	.more-button {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.75rem;
		height: 1.75rem;
		padding: 0;
		border: 0;
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--color-muted);
		font-size: 1.25rem;
		line-height: 1;
	}

	.more-button:hover,
	.more-button[aria-expanded='true'] {
		background: var(--color-highlight);
		color: var(--color-fg);
		opacity: 1;
	}

	.more-menu {
		position: absolute;
		top: calc(100% + var(--space-1));
		right: 0;
		min-width: 7rem;
		padding: var(--space-1);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-sm);
		background: var(--color-surface-raised);
		box-shadow: 0 6px 18px rgb(0 0 0 / 12%);
	}

	.more-menu button {
		display: block;
		width: 100%;
		padding: var(--space-1) var(--space-2);
		border: 0;
		background: transparent;
		text-align: left;
		font-size: 0.78rem;
	}

	.more-menu button:hover {
		background: var(--color-highlight);
		opacity: 1;
	}

	.author-meta {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}

	.author-meta time {
		color: var(--color-muted);
		font-size: 0.7rem;
		line-height: 1.3;
	}

	.author-meta strong {
		font-size: 0.86rem;
		line-height: 1.3;
	}

	.pending-status {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		color: var(--color-muted);
		font-size: 0.75rem;
	}

	.spinner {
		width: 0.75rem;
		height: 0.75rem;
		border: 2px solid var(--color-border);
		border-top-color: var(--color-muted);
		border-radius: 50%;
		animation: forum-spin 0.8s linear infinite;
	}

	@keyframes forum-spin {
		to { transform: rotate(360deg); }
	}

	.post-body,
	.reply-body {
		white-space: pre-wrap;
		word-break: break-word;
	}

	.post-body {
		margin: var(--space-2) 0;
		font-size: 0.9rem;
		line-height: 1.5;
	}

	.post-actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-3);
	}

	.icon-action {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
		min-height: 1.5rem;
		padding: 0;
		border: 0;
		background: transparent;
		color: var(--color-muted);
		font-size: 0.74rem;
	}

	.icon-action:hover,
	.icon-action[aria-expanded='true'] {
		border-color: transparent;
		background: transparent;
		color: var(--color-fg);
		opacity: 1;
	}

	.icon-action:disabled {
		border-color: transparent;
		background: transparent;
	}

	.action-icon {
		width: 1rem;
		height: 1rem;
		flex: 0 0 auto;
	}

	.action-count {
		line-height: 1;
	}

	/* A pending like is disabled to prevent duplicate requests, but its optimistic
	   colour should still be fully visible while the server confirms the count. */
	.icon-action.like-pending {
		opacity: 1;
	}

	.icon-action.liked {
		color: var(--color-success);
	}

	.delete-action {
		color: var(--color-danger);
	}

	.reply-form {
		display: block;
		margin: var(--space-2) 0 0;
		padding-left: calc(32px + var(--space-2));
	}

	.reply-node > .reply-form {
		padding-left: calc(24px + var(--space-2));
	}

	.reply-actions {
		justify-content: flex-start;
	}

	.replies {
		margin: var(--space-3) 0 0 calc(32px + var(--space-2));
		border: 1px solid var(--color-border);
		border-left: none;
		border-radius: var(--radius-sm);
		padding: 0 var(--space-3);
	}

	.reply {
		position: relative;
		padding: var(--space-2) var(--space-4) var(--space-2) 0;
	}

	.reply-node + .reply-node > .reply {
		border-top: 1px solid var(--color-border);
	}

	.reply-children {
		margin: var(--space-2) 0 0 var(--space-4);
		padding-left: var(--space-3);
		border-left: 1px solid var(--color-border);
	}

	.reply-body {
		margin: var(--space-1) 0;
		font-size: 0.86rem;
		line-height: 1.45;
	}

	.pending-post,
	.pending-reply {
		color: var(--color-muted);
	}

	.pending-post {
		border: 1px dashed var(--color-border);
		padding: var(--space-3);
		margin-bottom: var(--space-2);
		background: var(--color-surface-inset);
	}

	.pending-post .post-body,
	.pending-reply .reply-body {
		color: var(--color-fg);
	}

	.deleted .post-body,
	.deleted .reply-body {
		color: var(--color-muted);
		font-style: italic;
	}

	.state,
	.inline-error {
		margin: var(--space-4) 0;
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
		margin: var(--space-3) auto 0;
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

		.reply-children {
			margin-left: var(--space-3);
			padding-left: var(--space-2);
		}
	}
</style>
