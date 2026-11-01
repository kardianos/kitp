-- copy_project_template — the stamping entry point (card.insert's
-- auto-stamp and project.stamp): a plain graph-copy into a fresh project.
CREATE OR REPLACE FUNCTION copy_project_template(
    template_id bigint,
    new_project_id bigint,
    actor_id bigint
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    PERFORM copy_project_template_merge(template_id, new_project_id, actor_id, NULL);
END;
$$;
