-- A non-sensitive field key must not become a container for arbitrary nested
-- JSON. Enforce the governed field's scalar data type as well as its name.

create or replace function public.validate_governed_record_projection()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1
      from public.governed_datasets dataset
      join public.curated_records record
        on record.pipeline_id = dataset.source_pipeline_id
       and record.tenant_id = dataset.tenant_id
     where dataset.id = new.dataset_id
       and dataset.tenant_id = new.tenant_id
       and record.id = new.source_record_id
       and not record.is_deleted
  ) then
    raise exception 'Projection source must belong to the governed dataset pipeline';
  end if;

  if exists (
    select 1
      from jsonb_each(new.display_data) projected(field_key, field_value)
      left join public.governed_dataset_fields field
        on field.tenant_id = new.tenant_id
       and field.dataset_id = new.dataset_id
       and field.field_key = projected.field_key
     where field.id is null
        or field.is_sensitive
        or case field.data_type
          when 'text' then jsonb_typeof(projected.field_value) not in ('string', 'null')
          when 'date' then jsonb_typeof(projected.field_value) not in ('string', 'null')
          when 'timestamp' then jsonb_typeof(projected.field_value) not in ('string', 'null')
          when 'integer' then jsonb_typeof(projected.field_value) not in ('number', 'null')
          when 'decimal' then jsonb_typeof(projected.field_value) not in ('number', 'null')
          when 'boolean' then jsonb_typeof(projected.field_value) not in ('boolean', 'null')
          else true
        end
  ) then
    raise exception 'Projection contains an unknown, sensitive, or incorrectly typed field';
  end if;

  return new;
end
$$;

revoke execute on function public.validate_governed_record_projection() from public;
