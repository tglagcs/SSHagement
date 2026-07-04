<script lang="ts">
  import { cn } from "$lib/utils";

  type Props = {
    /** Render only the glyph, hiding the wordmark. */
    compact?: boolean;
    class?: string;
  };

  let { compact = false, class: className }: Props = $props();
</script>

<div class={cn("flex items-center gap-2.5 select-none", className)}>
  <!-- App icon -->
  <img
    src="/app-icon.png"
    alt="SSHagement"
    class="size-7 rounded-md"
    draggable="false"
  />

  {#if !compact}
    <span class="font-display inline-flex items-baseline leading-none">
      <span class="text-[16px] font-extrabold text-accent-ssh">SSH</span><span
        class="text-[11px] font-semibold text-[#7f8794]">agement</span
      >
    </span>
  {/if}
</div>
