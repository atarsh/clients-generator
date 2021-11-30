<?php

require_once (__DIR__. '/TypescriptGeneratorBase.php');
require_once (__DIR__. '/GeneratedFileData.php');

class EnumsGenerator extends TypescriptGeneratorBase
{

    function __construct($serverMetadata)
    {
        parent::__construct($serverMetadata);
    }

    public function generate()
    {
        $result = array();

        foreach ($this->serverMetadata->enumTypes as $enum) {
            // handle all enums even if they don't contain any values
            $result[] = $this->createEnumTypeExp($enum);
        }

        return $result;
    }

    function getEnumValueName(EnumValue $item)
    {
        $value = Utils::fromSnakeCaseToLowerCamelCase($item->name);

        // handle reserved names in javascript
        if ($value === 'name')
        {
            $value = "_name";
        }

        return $value;
    }
    function createEnumTypeExp(EnumType $enum)
    {
        $enumTypeName = Utils::upperCaseFirstLetter($enum->name);

        switch($enum->type)
        {
            case 'int':
                $values = array();
                foreach ($enum->values as $item) {
                    $enumValueName = $this->getEnumValueName($item);
                    $values[] = $enumValueName . "=" . $item->value;
                }

                $fileContent = "
{$this->getBanner()}
export enum {$enumTypeName} {
    {$this->utils->buildExpression($values,',' . NewLine, 1)}
}";
                break;
            case 'string':
                $values = array();
                foreach ($enum->values as $item) {
                    $enumValueName = $this->getEnumValueName($item);
                    $values[] = $enumValueName . " = '" . $item->value . "'";
                }

                 $fileContent = "
{$this->getBanner()}
export enum {$enumTypeName} {
    {$this->utils->buildExpression($values,',' . NewLine, 1)}
}";
                break;
        }

        $file = new GeneratedFileData();
        $fileName = $enumTypeName; //$this->utils->toLispCase($enumTypeName);
        $file->path = "types/{$fileName}.ts";
        $file->content = $fileContent;
        $result[] = $file;
        return $file;
    }
}