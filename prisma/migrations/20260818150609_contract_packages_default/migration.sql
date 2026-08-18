-- CreateTable
CREATE TABLE "contract_packages" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "notes" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contract_packages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contract_package_items" (
    "id" TEXT NOT NULL,
    "package_id" TEXT NOT NULL,
    "ticket_type_id" TEXT NOT NULL,
    "sla_policy_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contract_package_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contract_package_applications" (
    "id" TEXT NOT NULL,
    "package_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "applied_by_id" TEXT NOT NULL,
    "applied_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_count" INTEGER NOT NULL DEFAULT 0,
    "overwritten_count" INTEGER NOT NULL DEFAULT 0,
    "skipped_same_count" INTEGER NOT NULL DEFAULT 0,
    "skipped_different_count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "contract_package_applications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "contract_packages_organization_id_is_active_idx" ON "contract_packages"("organization_id", "is_active");

-- CreateIndex
CREATE INDEX "contract_packages_created_by_id_idx" ON "contract_packages"("created_by_id");

-- CreateIndex
CREATE UNIQUE INDEX "contract_packages_organization_id_name_key" ON "contract_packages"("organization_id", "name");

-- CreateIndex
CREATE INDEX "contract_package_items_sla_policy_id_idx" ON "contract_package_items"("sla_policy_id");

-- CreateIndex
CREATE UNIQUE INDEX "contract_package_items_package_id_ticket_type_id_key" ON "contract_package_items"("package_id", "ticket_type_id");

-- CreateIndex
CREATE INDEX "contract_package_applications_package_id_project_id_idx" ON "contract_package_applications"("package_id", "project_id");

-- CreateIndex
CREATE INDEX "contract_package_applications_project_id_applied_at_idx" ON "contract_package_applications"("project_id", "applied_at");

-- CreateIndex
CREATE INDEX "contract_package_applications_applied_by_id_idx" ON "contract_package_applications"("applied_by_id");

-- AddForeignKey
ALTER TABLE "contract_packages" ADD CONSTRAINT "contract_packages_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contract_packages" ADD CONSTRAINT "contract_packages_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contract_package_items" ADD CONSTRAINT "contract_package_items_package_id_fkey" FOREIGN KEY ("package_id") REFERENCES "contract_packages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contract_package_items" ADD CONSTRAINT "contract_package_items_ticket_type_id_fkey" FOREIGN KEY ("ticket_type_id") REFERENCES "ticket_types"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contract_package_items" ADD CONSTRAINT "contract_package_items_sla_policy_id_fkey" FOREIGN KEY ("sla_policy_id") REFERENCES "sla_policies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contract_package_applications" ADD CONSTRAINT "contract_package_applications_package_id_fkey" FOREIGN KEY ("package_id") REFERENCES "contract_packages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contract_package_applications" ADD CONSTRAINT "contract_package_applications_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contract_package_applications" ADD CONSTRAINT "contract_package_applications_applied_by_id_fkey" FOREIGN KEY ("applied_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
